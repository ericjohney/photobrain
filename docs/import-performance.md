# Import Performance and Architecture

This document separates implemented optimizations from proposed architectural work. The scoped API and image-processing guides remain the implementation references.

## Implemented Changes

- One synchronous SQLite transaction per existing scan/embedding save batch, with upserts and stable photo IDs. Native processing and network progress publishing remain outside transactions.
- EXIF metadata extraction in bounded commands: at most 20 paths and 32 KiB of path arguments. Records are matched by absolute `SourceFile`; good records survive mixed failures and only unresolved paths are retried individually. Original symlink filenames are preserved because RAW interpretation can depend on their extension.
- One reusable, at-most-four-thread Rayon pool for native batch/callback processing. Single-photo and standalone helper paths are unchanged.
- No pixel-buffer clone when an image already fits a thumbnail size. Resize filtering and lossless WebP encoding are unchanged.
- API import discovery, media processing, and image embeddings run on one persistent `node:worker_threads` worker under Bun. One operation executes at a time, with at most eight running/queued requests per API process. Overload and worker failures reject the step so Inngest can retry; the executor never silently repeats native writes.

The worker thread is not a new deployable service or durable queue. Inngest still owns orchestration and checkpoints, and SQLite still has one API-thread writer. Native caches survive between batches. Worker offloading is principally a responsiveness improvement, not proof of higher native throughput. It does not isolate native process crashes, fence competing scan generations, or add ExifTool timeouts. Direct text-search and maintenance native calls still run on the API thread.

Existing function IDs, checkpoint names/results, batch sizes, event payloads, and phase ordering are preserved. Idle worker threads are unreferenced; pending work keeps them alive. No image-quality, model, SQLite durability, or thumbnail path changes are included.

## Measurements

`bun run bench:import` from `apps/api` compares file-backed persistence against the previous per-photo write strategy. It does not measure native processing.

`bun run bench:exif <1-20 distinct photo paths>` from `apps/api` compares one metadata command against per-file commands at up to four-way concurrency, using the current Rust metadata flags. It checks exact JSON equivalence, warms both modes, then reports five alternating rounds. Set `EXIFTOOL_BIN` only for this benchmark to select a particular executable. It reads but never modifies the supplied photos.

An isolated CLI experiment in this workspace used ExifTool 13.59, ten small PNGs and ten small JPEG metadata fixtures, with synthetic orientation/camera/exposure/GPS tags. Five alternating warm rounds gave these EXIF-only medians:

| Mode | Processes per 20 files | Median |
| --- | --- | --- |
| Previous per-file pattern, up to four concurrent | 20 | 325.6 ms |
| One batch | 1 | 96.9 ms |

All parsed records matched by `SourceFile`. This is a 3.36x metadata-only improvement on small synthetic inputs, not a camera-corpus or end-to-end speedup. RAW preview subprocesses are additional and unchanged. Real mixed-file CLI checks also confirmed that `-Error` must be requested explicitly and that missing files may have no JSON record at all.

Worker tests use real Bun worker threads with a blocking TypeScript fixture. They verify timer responsiveness during execution, FIFO reuse, bounded admission, errors, worker restart, and shutdown. They do not validate the real N-API addon in a worker. Rust parser/command/pool/thumbnail tests are included; this workspace lacks a C linker and native dependencies, so the native crate and real worker/addon lifecycle still need build/runtime verification before rollout.

For a release-build camera-corpus benchmark, measure fresh imports, unchanged rescans, one-file changes, artifact repair, and embedding-only recovery separately. Record EXIF, preview/decode, pHash, resize/encode/write, model initialization/image loading/inference, database saves, peak RSS, and API latency. Separate cold/warm filesystem and model caches. Current logs split aggregate EXIF from the rest of native media processing, and native queue/execution from database saves; the embedding timer includes image loading and model initialization, not just inference.

## Recommended Next Architecture

The largest avoidable rescan cost is doing all media and CLIP work again for unchanged photos. Implement a conservative incremental planner before increasing concurrency or streaming embeddings.

### Reliable Identity

Current `modifiedAt` storage truncates timestamps to seconds. Add separate precise source fingerprint fields rather than comparing fresh millisecond timestamps against that field. Include processing/model versions and a source/artifact generation; legacy rows with no fingerprint require a conservative validation pass. Size/mtime, even precise, remains a heuristic: support a deliberate force/deep verification path for preserved-timestamp edits. Define a library/root identity rather than assuming relative paths identify the same files after changing `PHOTO_DIRECTORY`.

Thumbnail correctness must come first. Native thumbnail errors currently can leave `success: true`, and path naming strips the original extension, so `photo.jpg` and `photo.cr3` collide. Use a collision-free key including full source identity, write an immutable generation, and atomically publish its database pointer only after all required outputs succeed. Migrate serving/RAW fallback/cache keys together; preserve a concrete transition path for existing stored thumbnails. Do not treat file existence alone as current-generation validity.

Check source identity before and after processing. A changing/disappearing source must not publish an allegedly current artifact. Do not add deletion reconciliation as part of the first incremental change.

### Work Classification

| State | Action |
| --- | --- |
| New/changed source or obsolete media pipeline | Process media, then embed its committed generation |
| Unchanged source, valid artifacts and current vector | Skip native work and database mutation |
| Unchanged source, valid artifacts, missing/failed/outdated vector | Embedding only |
| Unchanged source with missing/invalid artifacts | Repair artifacts |
| Unknown legacy fingerprint or force mode | Conservative processing |
| Stat/processing failure | Record failure; never classify as unchanged |

An all-unchanged scan must succeed, keep thumbnail cache keys stable, and still recover pending embeddings from a previously interrupted scan. EXIF absence is legitimate and must not force perpetual rescanning. Track examined/unchanged/media/embedding outcomes separately while preserving existing user-visible progress until clients are deliberately updated.

### Bounded Work Records

The current workflow puts the whole discovery result and eventual embedding ID list into Inngest state/events, selects all embedding paths with one `IN` query, and grows checkpoint count with library size. With Realtime's checkpointed publishing, the scan is roughly four steps per 20 photos plus fixed overhead: around 5,000 photos can reach the documented 1,000-step function limit. Actual runtime/plan limits must be checked.

Persist an immutable scan manifest with stable ordinals, source fingerprints, planned actions, outcomes, and artifact generations. Persist embedding tasks keyed by `(photoId, artifactGeneration, modelVersion)`, plus job membership. Send bounded chunk/task IDs, not library-sized paths or vectors. Chunk function runs as well as event payloads; merely splitting the final embedding event does not fix scan-state or step-count growth.

Keep task intent atomic with the existing save transaction. Use an outbox and a real delivery reconciler so a crash between commit and event dispatch cannot strand work. Use stable membership/keyset pagination rather than offsets over a shrinking pending set. Version workflow events/functions or drain active runs before changing replay-sensitive loop membership and checkpoint shapes.

### Ownership and Freshness

Inngest function concurrency limits apply to executing steps, not an exclusive whole-import lifecycle. Different runs can interleave; scan and embedding function limits are separate. The in-process worker limits native resource usage, not database/artifact ownership, and multiple API processes each have their own executor.

Initially coalesce or reject a second active import for the same library using durable ownership with recovery/fencing, including the embedding phase. Every vector/status save must check the expected artifact generation so an older success or failure cannot overwrite newer work. Inference must read an immutable artifact for that generation.

Choose an explicit semantic-search freshness policy. Today old vectors remain searchable while pending/failed regardless of source changes. Strict current-generation search and stale-while-revalidate are different product contracts. Also distinguish retryable model/runtime failure from a permanently unreadable image; current CLIP code turns both into null results.

### Streaming Later

The preferred longer-term architecture is a durable producer/consumer pipeline: media saves enqueue generation-specific embedding tasks, a bounded consumer fills batches of 16 across producer chunks, and a coordinator owns final job completion. Completion requires discovery closed, media work terminal, and every required embedding task terminal.

Do not emit the existing embedding event after each media batch unchanged: its child finalizes the entire job, so the first child could prematurely finish an ongoing scan. Mobile also assumes monotonic phase order, so alternating processing/embedding phases requires stage counters or a compatible overall phase. Measure time to first searchable photo separately from total throughput.

A separate native execution service is justified only when measured CPU/memory contention or fault isolation requires it. It introduces deployment and shared-storage ownership work and does not remove SQLite's single-writer boundary. The bounded in-process thread is the smaller first step.

## Alternatives Deferred

| Alternative | Potential benefit | Reason not to enable yet |
| --- | --- | --- |
| Persistent ExifTool pool | Further startup amortization, especially RAW | Request framing, binary preview framing, timeouts, child restart/shutdown |
| Resize pyramid or libvips | Less full-source filtering and memory | Pixel/color/orientation/alpha/HEIF equivalence and native deployment validation |
| Lossy WebP | Lower encode cost and output size | Deliberate image-quality and embedding-input change; current quality fields are unused |
| Smaller CLIP artifact or reduced decode | Less I/O, decode and preprocessing | Preserve crop/color/preprocessing and pHash semantics; version affected outputs |
| More image models or native workers | Possible overlap | Cached image model mutex, runtime threads, memory and API contention must be measured |
| WAL or reduced synchronous mode | Reader/writer coexistence or fewer flushes | Storage compatibility and durability are explicit decisions, not default speed fixes |

## References

- [API implementation guide](../apps/api/AGENTS.md)
- [Native processing guide](../packages/image-processing/AGENTS.md)
- [Database guide](../packages/db/AGENTS.md)
- [Inngest concurrency](https://www.inngest.com/docs/guides/concurrency)
- [Inngest limits](https://www.inngest.com/docs/usage-limits/inngest)
