use crossbeam_channel::{Receiver, Sender, bounded, select_biased};
use napi::bindgen_prelude::AsyncTask;
use napi::{Env, Error, Result, Task};
use napi_derive::napi;
use parking_lot::{Condvar, Mutex};
use std::panic::{AssertUnwindSafe, catch_unwind};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::thread::{self, JoinHandle};

use crate::batch::{PhotoProcessingResult, process_photo_internal, processing_pool};
use crate::exif::{ExifData, METADATA_CHUNK_SIZE, extract_exif_batch};

#[napi(object)]
pub struct PhotoStreamResult {
  pub index: u32,
  pub result: PhotoProcessingResult,
}

struct ReadyPhoto {
  index: usize,
  exif: Option<ExifData>,
}

#[derive(Default)]
struct Completion {
  finished: bool,
  error: Option<String>,
}

struct StreamState {
  // Disconnecting this sender broadcasts cancellation to every blocked queue operation.
  cancel: Mutex<Option<Sender<()>>>,
  cancelled: Receiver<()>,
  results: Receiver<PhotoStreamResult>,
  completion: Mutex<Completion>,
  finished: Condvar,
  controller: Mutex<Option<JoinHandle<()>>>,
  next_pending: AtomicBool,
}

impl StreamState {
  fn cancel(&self) {
    self.cancel.lock().take();
  }

  fn is_cancelled(&self) -> bool {
    self
      .cancelled
      .try_recv()
      .is_err_and(|error| error.is_disconnected())
  }

  fn fail(&self, error: String) {
    self.completion.lock().error.get_or_insert(error);
    self.cancel();
  }

  fn wait_finished(&self) -> Result<()> {
    let mut completion = self.completion.lock();
    while !completion.finished {
      self.finished.wait(&mut completion);
    }
    let error = completion.error.clone();
    drop(completion);
    let controller = self.controller.lock().take();
    if let Some(controller) = controller {
      controller
        .join()
        .map_err(|_| Error::from_reason("Photo stream controller panicked"))?;
    }
    match error {
      Some(error) => Err(Error::from_reason(error)),
      None => Ok(()),
    }
  }

  fn next_result(&self) -> Result<Option<PhotoStreamResult>> {
    select_biased! {
      recv(self.cancelled) -> _ => {},
      recv(self.results) -> result => {
        if let Ok(result) = result {
          return Ok(Some(result));
        }
      }
    }
    self.wait_finished()?;
    Ok(None)
  }
}

/// A single-consumer stream. Its native producers continue across JavaScript checkpoints.
#[napi]
pub struct PhotoProcessingStream {
  state: Arc<StreamState>,
}

#[napi]
impl PhotoProcessingStream {
  #[napi(ts_return_type = "Promise<PhotoStreamResult | null>")]
  pub fn next(&self) -> Result<AsyncTask<NextPhotoTask>> {
    if self.state.next_pending.swap(true, Ordering::AcqRel) {
      return Err(Error::from_reason(
        "Only one photo stream next() may be pending",
      ));
    }
    Ok(AsyncTask::new(NextPhotoTask {
      state: self.state.clone(),
    }))
  }

  #[napi(ts_return_type = "Promise<void>")]
  pub fn close(&self) -> AsyncTask<ClosePhotoTask> {
    // Signal on the calling thread, before queueing libuv work. Even pending next()
    // calls occupying libuv threads are woken without waiting for close's task to run.
    self.state.cancel();
    AsyncTask::new(ClosePhotoTask {
      state: self.state.clone(),
    })
  }
}

impl Drop for PhotoProcessingStream {
  fn drop(&mut self) {
    // The controller owns and joins its scoped children. GC never joins on the JS thread.
    self.state.cancel();
  }
}

pub struct NextPhotoTask {
  state: Arc<StreamState>,
}

impl Task for NextPhotoTask {
  type Output = Option<PhotoStreamResult>;
  type JsValue = Option<PhotoStreamResult>;

  fn compute(&mut self) -> Result<Self::Output> {
    self.state.next_result()
  }

  fn resolve(&mut self, _env: Env, output: Self::Output) -> Result<Self::JsValue> {
    Ok(output)
  }
}

impl Drop for NextPhotoTask {
  fn drop(&mut self) {
    self.state.next_pending.store(false, Ordering::Release);
  }
}

pub struct ClosePhotoTask {
  state: Arc<StreamState>,
}

impl Task for ClosePhotoTask {
  type Output = ();
  type JsValue = ();

  fn compute(&mut self) -> Result<Self::Output> {
    self.state.wait_finished()
  }

  fn resolve(&mut self, _env: Env, output: Self::Output) -> Result<Self::JsValue> {
    Ok(output)
  }
}

#[napi]
pub fn start_photo_processing(
  file_paths: Vec<String>,
  relative_paths: Vec<String>,
  thumbnails_dir: String,
  thumbnail_paths: Option<Vec<String>>,
) -> Result<PhotoProcessingStream> {
  if thumbnail_paths
    .as_ref()
    .is_some_and(|paths| paths.len() != file_paths.len())
  {
    return Err(Error::from_reason(
      "Photo filePaths and thumbnailPaths must have equal lengths",
    ));
  }
  let pool = processing_pool()?;
  start_stream(
    file_paths,
    relative_paths,
    pool.current_num_threads(),
    extract_exif_batch,
    move |index, path, relative_path, exif| {
      let thumbnail_path = thumbnail_paths
        .as_ref()
        .map_or(relative_path, |paths| paths[index].as_str());
      pool.install(|| {
        process_photo_internal(path, relative_path, &thumbnails_dir, thumbnail_path, || {
          exif
        })
      })
    },
  )
}

// The injected functions replace only metadata/media work, not the scheduler. The
// same queues, cancellation and lifetimes are exercised by deterministic regressions.
fn start_stream(
  file_paths: Vec<String>,
  relative_paths: Vec<String>,
  workers: usize,
  load_exif: impl Fn(&[String]) -> Vec<Option<ExifData>> + Send + Sync + 'static,
  process: impl Fn(usize, &str, &str, Option<ExifData>) -> PhotoProcessingResult + Send + Sync + 'static,
) -> Result<PhotoProcessingStream> {
  if file_paths.len() != relative_paths.len() {
    return Err(Error::from_reason(
      "Photo filePaths and relativePaths must have equal lengths",
    ));
  }
  if file_paths.len() > u32::MAX as usize {
    return Err(Error::from_reason("Too many photos for stream indices"));
  }
  let capacity = workers
    .checked_mul(2)
    .filter(|capacity| *capacity > 0)
    .ok_or_else(|| Error::from_reason("Invalid photo stream worker count"))?;
  let (cancel, cancelled) = bounded(0);
  let (result_sender, results) = bounded(capacity);
  let (ready_sender, ready) = bounded::<ReadyPhoto>(capacity);
  let state = Arc::new(StreamState {
    cancel: Mutex::new(Some(cancel)),
    cancelled,
    results,
    completion: Mutex::new(Completion::default()),
    finished: Condvar::new(),
    controller: Mutex::new(None),
    next_pending: AtomicBool::new(false),
  });
  let controller_state = state.clone();
  let controller = thread::Builder::new().name("photo-stream".into()).spawn(move || {
    let run = catch_unwind(AssertUnwindSafe(|| {
      thread::scope(|scope| {
        let state = &controller_state;
        let paths = &file_paths;
        let relatives = &relative_paths;
        let load_exif = &load_exif;
        let producer = thread::Builder::new().name("photo-exif".into()).spawn_scoped(scope, move || {
          run_guarded(state, || {
            for (chunk_index, paths) in paths.chunks(METADATA_CHUNK_SIZE).enumerate() {
              if state.is_cancelled() { return; }
              let metadata = load_exif(paths);
              if metadata.len() != paths.len() {
                state.fail("Photo metadata results lost input alignment".into());
                return;
              }
              for (offset, exif) in metadata.into_iter().enumerate() {
                let photo = ReadyPhoto { index: chunk_index * METADATA_CHUNK_SIZE + offset, exif };
                select_biased! {
                  recv(state.cancelled) -> _ => return,
                  send(ready_sender, photo) -> sent => if sent.is_err() { return; },
                }
              }
            }
          });
          drop(ready_sender);
        });
        if let Err(error) = producer {
          state.fail(format!("Failed to start EXIF producer: {error}"));
          return;
        }
        for index in 0..workers {
          let ready = ready.clone();
          let results = result_sender.clone();
          let process = &process;
          let worker = thread::Builder::new().name(format!("photo-dispatch-{index}"))
            .spawn_scoped(scope, move || run_guarded(state, || loop {
              let photo = select_biased! {
                recv(state.cancelled) -> _ => return,
                recv(ready) -> photo => match photo { Ok(photo) => photo, Err(_) => return },
              };
              if state.is_cancelled() { return; }
              // Only media work enters Rayon. Channel waits stay on dispatch threads:
              // blocking Rayon workers here can deadlock nested thumbnail parallelism.
              let result = process(photo.index, &paths[photo.index], &relatives[photo.index], photo.exif);
              select_biased! {
                recv(state.cancelled) -> _ => return,
                send(results, PhotoStreamResult { index: photo.index as u32, result }) -> sent => {
                  if sent.is_err() { return; }
                },
              }
            }));
          if let Err(error) = worker {
            state.fail(format!("Failed to start photo dispatcher: {error}"));
            break;
          }
        }
        drop(result_sender);
      });
    }));
    if run.is_err() {
      controller_state.fail("Photo stream controller panicked".into());
    }
    controller_state.completion.lock().finished = true;
    controller_state.finished.notify_all();
  }).map_err(|error| Error::from_reason(format!("Failed to start photo stream: {error}")))?;
  *state.controller.lock() = Some(controller);
  Ok(PhotoProcessingStream { state })
}

fn run_guarded(state: &StreamState, work: impl FnOnce()) {
  if catch_unwind(AssertUnwindSafe(work)).is_err() {
    // Cancel before joining siblings: a sibling may be blocked on a full queue.
    state.fail("Photo stream producer or processor panicked".into());
  }
}

#[cfg(test)]
mod tests {
  use super::*;
  use std::sync::atomic::AtomicUsize;
  use std::time::Duration;

  const TIMEOUT: Duration = Duration::from_secs(10);

  fn paths(count: usize) -> (Vec<String>, Vec<String>) {
    (
      (0..count).map(|i| format!("/source/{i}.jpg")).collect(),
      (0..count).map(|i| format!("album/{i}.jpg")).collect(),
    )
  }

  fn result(index: usize, path: &str) -> PhotoProcessingResult {
    PhotoProcessingResult {
      path: path.into(),
      name: format!("{index}.jpg"),
      size: 1,
      created_at: 0.0,
      modified_at: 0.0,
      width: None,
      height: None,
      mime_type: None,
      phash: None,
      exif: None,
      is_raw: false,
      raw_format: None,
      raw_status: None,
      raw_error: None,
      success: index != 7,
      error: (index == 7).then(|| "deliberate failure".into()),
    }
  }

  fn no_exif(paths: &[String]) -> Vec<Option<ExifData>> {
    vec![None; paths.len()]
  }

  #[test]
  fn blocked_first_photo_does_not_hold_later_windows_and_indices_stay_aligned() {
    let (files, relatives) = paths(64);
    let (release, blocked) = bounded::<()>(0);
    let (entered, first_started) = bounded(1);
    let stream = start_stream(
      files,
      relatives,
      2,
      no_exif,
      move |index, file, relative, _| {
        assert_eq!(file, format!("/source/{index}.jpg"));
        assert_eq!(relative, format!("album/{index}.jpg"));
        if index == 0 {
          entered.send(()).unwrap();
          blocked.recv_timeout(TIMEOUT).unwrap();
        }
        result(index, relative)
      },
    )
    .unwrap();
    first_started.recv_timeout(TIMEOUT).unwrap();
    let mut seen = vec![false; 64];
    // More than a full output checkpoint completes while input zero is still blocked.
    for _ in 0..30 {
      let photo = stream.state.results.recv_timeout(TIMEOUT).unwrap();
      assert_ne!(photo.index, 0);
      assert_eq!(photo.result.path, format!("album/{}.jpg", photo.index));
      assert_eq!(photo.result.success, photo.index != 7);
      assert!(!std::mem::replace(&mut seen[photo.index as usize], true));
    }
    assert!(seen[20..].iter().any(|seen| *seen));
    release.send(()).unwrap();
    for _ in 30..64 {
      let photo = stream.state.results.recv_timeout(TIMEOUT).unwrap();
      assert!(!std::mem::replace(&mut seen[photo.index as usize], true));
    }
    assert!(seen.iter().all(|seen| *seen));
    assert!(stream.state.next_result().unwrap().is_none());
  }

  #[test]
  fn full_result_queue_bounds_work_and_cancellation_joins_all_producers() {
    let (files, relatives) = paths(200);
    let pool = rayon::ThreadPoolBuilder::new()
      .num_threads(2)
      .build()
      .unwrap();
    let batches = Arc::new(AtomicUsize::new(0));
    let batch_count = batches.clone();
    let started = Arc::new(AtomicUsize::new(0));
    let starts = started.clone();
    let (completed, observed) = bounded(200);
    let stream = start_stream(
      files,
      relatives,
      2,
      move |paths| {
        batch_count.fetch_add(1, Ordering::SeqCst);
        no_exif(paths)
      },
      move |index, _, relative, _| {
        starts.fetch_add(1, Ordering::SeqCst);
        completed.send(()).unwrap();
        pool.install(|| rayon::join(|| result(index, relative), || ()).0)
      },
    )
    .unwrap();
    // Four buffered results and two dispatchers blocked trying to publish results.
    for _ in 0..6 {
      observed.recv_timeout(TIMEOUT).unwrap();
    }
    assert_eq!(stream.state.results.len(), 4);
    assert_eq!(started.load(Ordering::SeqCst), 6);
    assert_eq!(batches.load(Ordering::SeqCst), 1);
    stream.state.cancel();
    stream.state.wait_finished().unwrap();
    assert_eq!(started.load(Ordering::SeqCst), 6);
    assert_eq!(batches.load(Ordering::SeqCst), 1);
    assert!(stream.state.next_result().unwrap().is_none());
  }

  #[test]
  fn close_waits_for_active_writer_and_prevents_further_starts() {
    let (files, relatives) = paths(40);
    let (entered, writing) = bounded(1);
    let (release, finish_write) = bounded::<()>(0);
    let writes = Arc::new(AtomicUsize::new(0));
    let written = writes.clone();
    let stream = start_stream(
      files,
      relatives,
      1,
      no_exif,
      move |index, _, relative, _| {
        entered.send(()).unwrap();
        finish_write.recv_timeout(TIMEOUT).unwrap();
        written.fetch_add(1, Ordering::SeqCst);
        result(index, relative)
      },
    )
    .unwrap();
    writing.recv_timeout(TIMEOUT).unwrap();
    let _close = stream.close();
    assert!(!stream.state.completion.lock().finished);
    release.send(()).unwrap();
    stream.state.wait_finished().unwrap();
    assert_eq!(writes.load(Ordering::SeqCst), 1);
    assert!(stream.state.next_result().unwrap().is_none());
  }

  #[test]
  fn processor_panic_cancels_instead_of_hanging_full_queues() {
    let (files, relatives) = paths(80);
    let stream = start_stream(files, relatives, 2, no_exif, |_, _, _, _| {
      panic!("deliberate processor panic")
    })
    .unwrap();
    assert!(stream.state.next_result().is_err());
    assert!(stream.state.wait_finished().is_err());
  }

  #[test]
  fn close_signals_even_before_its_async_task_is_scheduled() {
    let (files, relatives) = paths(1);
    let (entered, writing) = bounded(1);
    let (release, finish_write) = bounded::<()>(0);
    let stream = start_stream(
      files,
      relatives,
      1,
      no_exif,
      move |index, _, relative, _| {
        entered.send(()).unwrap();
        finish_write.recv_timeout(TIMEOUT).unwrap();
        result(index, relative)
      },
    )
    .unwrap();
    writing.recv_timeout(TIMEOUT).unwrap();
    let next = stream.next().unwrap();
    assert!(stream.next().is_err());
    // As with a saturated libuv pool, close's AsyncTask has not run at all.
    let _close = stream.close();
    assert!(stream.state.is_cancelled());
    release.send(()).unwrap();
    assert!(stream.state.next_result().unwrap().is_none());
    drop(next);
    assert!(stream.next().is_ok());
  }

  #[test]
  fn mismatched_inputs_are_rejected_and_empty_stream_finishes() {
    assert!(
      start_stream(
        vec!["photo.jpg".into()],
        vec![],
        2,
        no_exif,
        |index, _, relative, _| result(index, relative)
      )
      .is_err()
    );
    let stream = start_stream(vec![], vec![], 2, no_exif, |index, _, relative, _| {
      result(index, relative)
    })
    .unwrap();
    assert!(stream.state.next_result().unwrap().is_none());
  }

  #[test]
  fn thumbnail_keys_keep_same_stem_sources_distinct_and_preserve_result_identity() {
    let temp = tempfile::tempdir().unwrap();
    let thumbnails = temp.path().join("thumbnails");
    let relatives = vec!["album/photo.png".to_string(), "album/photo.jpg".to_string()];
    let keys = vec![
      ".versions/first/preview.png".to_string(),
      ".versions/second/preview.jpg".to_string(),
    ];
    let dimensions = [(32, 16), (16, 32)];
    let mut files = Vec::new();
    for (relative, (width, height)) in relatives.iter().zip(dimensions) {
      let source = temp.path().join(relative);
      std::fs::create_dir_all(source.parent().unwrap()).unwrap();
      image::DynamicImage::new_rgb8(width, height)
        .save(&source)
        .unwrap();
      files.push(source.to_string_lossy().into_owned());
    }
    let stream = start_photo_processing(
      files.clone(),
      relatives.clone(),
      thumbnails.to_string_lossy().into_owned(),
      Some(keys.clone()),
    )
    .unwrap();
    let mut seen = [false; 2];
    for _ in 0..2 {
      let photo = stream.state.results.recv_timeout(TIMEOUT).unwrap();
      let index = photo.index as usize;
      assert!(!std::mem::replace(&mut seen[index], true));
      assert!(photo.result.success, "{:?}", photo.result.error);
      assert_eq!(photo.result.path, relatives[index]);
      assert_eq!(
        photo.result.name,
        if index == 0 { "photo.png" } else { "photo.jpg" }
      );
    }
    assert!(stream.state.next_result().unwrap().is_none());
    for (key, expected) in keys.iter().zip(dimensions) {
      for size in ["tiny", "small", "medium", "large"] {
        let artifact = thumbnails.join(size).join(key).with_extension("webp");
        let image = image::open(artifact).unwrap();
        assert_eq!((image.width(), image.height()), expected);
        assert!(!thumbnails.join(size).join("album/photo.webp").exists());
      }
    }

    // Omitting output keys still writes the mirrored original path.
    let stream = start_photo_processing(
      vec![files[0].clone()],
      vec![relatives[0].clone()],
      thumbnails.to_string_lossy().into_owned(),
      None,
    )
    .unwrap();
    let photo = stream.state.results.recv_timeout(TIMEOUT).unwrap();
    assert!(photo.result.success, "{:?}", photo.result.error);
    assert_eq!(photo.result.path, relatives[0]);
    assert!(stream.state.next_result().unwrap().is_none());
    for size in ["tiny", "small", "medium", "large"] {
      let image = image::open(thumbnails.join(size).join("album/photo.webp")).unwrap();
      assert_eq!((image.width(), image.height()), dimensions[0]);
    }
  }

  #[test]
  fn output_keys_must_align_and_do_not_replace_failed_source_identity() {
    for keys in [vec![], vec!["one.jpg".into(), "two.jpg".into()]] {
      assert!(
        start_photo_processing(
          vec!["missing.jpg".into()],
          vec!["album/missing.jpg".into()],
          "unused".into(),
          Some(keys),
        )
        .is_err()
      );
    }
    let temp = tempfile::tempdir().unwrap();
    let stream = start_photo_processing(
      vec![
        temp
          .path()
          .join("missing.jpg")
          .to_string_lossy()
          .into_owned(),
      ],
      vec!["album/missing.jpg".into()],
      temp.path().to_string_lossy().into_owned(),
      Some(vec![".versions/attempt/preview.jpg".into()]),
    )
    .unwrap();
    let photo = stream.state.results.recv_timeout(TIMEOUT).unwrap();
    assert!(!photo.result.success);
    assert_eq!(photo.result.path, "album/missing.jpg");
    assert_eq!(photo.result.name, "missing.jpg");
    assert!(stream.state.next_result().unwrap().is_none());
  }
}
