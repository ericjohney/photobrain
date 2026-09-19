# Import Performance and Architecture

This document separates implemented optimizations from proposed architectural work. The scoped API and image-processing guides remain the implementation references.

## Implemented Changes

- Synchronous SQLite transactions with upserts and stable photo IDs. Streaming scan transactions now include each completed photo, its receipt, counters, and durable progress; embeddings retain transactional batches. Native processing and network publishing stay outside transactions.
- EXIF metadata extraction in bounded commands: at most 20 paths and 32 KiB of path arguments. Records are matched by absolute `SourceFile`; good records survive mixed failures and only unresolved paths are retried individually. Original symlink filenames are preserved because RAW interpretation can depend on their extension.
- One reusable Rayon pool sized by available CPU capacity, with a positive `PHOTO_PROCESSING_THREADS` override for memory-constrained deployments.
- One original-to-`large` resize bounded at 1,600 pixels, then smaller outputs resized from that bounded preview with dimensions calculated from the original aspect ratio. Already-fitting images avoid pixel-buffer clones. Bundled libwebp now applies the configured lossy color qualities 80/85/85/90 for tiny/small/medium/large, with lossless alpha encoding. Derived preview pixels and embedding inputs therefore change; originals, orientation handling, pHash input, and EXIF extraction are unchanged.
- Thumbnail encode/write errors fail the photo result rather than leaving it successful and marking thumbnails ready.
- SQLite `scan_manifests`/`scan_items` freeze discovery and stable new-first dispatch ordering. New photos enter the queue first, but completion order is unrestricted: a slow new photo does not prevent other workers from starting existing photos. Existing photos still reset to pending embeddings; this is not incremental skipping.
- `startPhotoProcessing` independently prefetches bounded EXIF chunks and continuously feeds media workers. Ready/results queues each hold at most twice the worker count; dispatch-channel waits never occupy Rayon workers. One completion at a time reaches the API and receives an ACK after its atomic persistence. `scan-photos-v4` checkpoints every 20 completed results without restarting the stream. Lost checkpoints or worker/process restarts resume pending receipts instead of repeating acknowledged work.
- Web and mobile refresh library queries on advancing processing counts: the first advance immediately, then coalesced trailing refreshes at most once per second. They also refresh at `scan-complete`/first embedding progress and terminal progress; embedding remains nonterminal, and terminal progress refreshes search. Web adds a 1,500 ms durable polling fallback; mobile retains its existing recovery polling.
- API discovery, continuous media processing, HEIC maintenance, and CLIP image batches use one persistent `node:worker_threads` worker under Bun. At most eight requests are running/queued per process. One photo stream survives checkpoint windows; a job switch or other native operation first cancels/drains it. Load/completion callbacks preserve their caller's async context, including Inngest Realtime publication.

The worker thread is not a new deployable service or durable queue. Inngest owns checkpoints; SQLite has one API-thread writer and durable per-photo work receipts. Native result queues absorb checkpoint/persistence latency only up to their bounds: the system applies backpressure rather than consuming unlimited memory. CPU utilization can fall during startup, I/O/ExifTool waits, slow persistence, or the final stragglers. This does not isolate native process crashes, fence competing artifact generations, or add ExifTool timeouts. Direct text search remains synchronous.

Drain active old scan runs, rebuild the addon, and apply migration `0005_continuous_scan_work.sql` before deploying `scan-photos-v4`; its function/checkpoint graph is replay-sensitive. Public event/API payloads, phase ordering, model, SQLite durability settings, and thumbnail paths are unchanged. One final embedding event follows durable/Realtime `scan-complete`; the parent makes no subsequent progress writes. Receipts are retained until dispatch is checkpointed and explicitly cleaned on success/terminal failure. These changes are locally verified, not deployed.

## Measurements

### Continuous pool — 2026-09-19

Compared the immediately preceding four-worker, first-4/then-20 batch implementation with the rolling pool on the same 80 read-only production originals described below. Release builds used Apple M4 Pro (12 available CPUs), Bun 1.4.2, and the same preview encoder. Each row summarizes three warm-filesystem runs with isolated file-backed SQLite databases and unchanged default durability settings. Rolling runs include per-photo receipts and progress transactions. The first 12-worker trial overlapped validation and was excluded; the next three trials are reported.

| Mode | Median media + persistence | Median first commit | Median average process CPU | Peak process RSS range |
| --- | --- | --- | --- | --- |
| Previous batches, 4 workers | 9.040 s | 551 ms (up to 4 photos) | 3.46 cores | 1,338–1,551 MiB |
| Rolling, 4 workers | 8.864 s | 496 ms (1 photo) | 3.56 cores | 1,381–1,697 MiB |
| Rolling, 8 workers | 5.496 s | 549 ms (1 photo) | 5.97 cores | 1,711–1,936 MiB |
| Rolling, default 12 workers | 4.835 s | 466 ms (1 photo) | 7.13 cores | 2,173–2,397 MiB |

Eight workers delivered 1.64x throughput; the local default delivered 1.87x. The same-four-worker result is only about 2% faster, so increased concurrency accounts for most of this sample's throughput gain; the rolling design separately removes straggler barriers. Process CPU excludes child ExifTool CPU and is an average including startup/tail, not a promise of 100% occupancy. Production currently exposes 8 CPUs, but the eight-worker row still ran on the Mac, not production hardware. More workers increase memory; use the override rather than assuming every available CPU is safe on a memory-limited host.

All modes produced 77 successes and the same three missing-preview DNG failures. All 80 full result objects, including EXIF, dimensions and pHash, matched the preceding implementation. SHA-256 checks preserved all 80 originals; the 308 generated WebPs were byte-identical at 4/8/12 workers and after the real runtime/HEIC-maintenance runs. This scheduling change does not alter the already-optimized preview quality.

An actual fresh API/Inngest/web run displayed its first real photo at 1.093 s while progress was `processing` at 1/80. All 77 successful photos were listed at 6.475 s; 77 vectors and terminal completion followed at 13.506 s using a populated model cache. Both early and completed grids were visually verified. Across 132 HTTP health probes, median/p95/max latency was 0.342/9.224/35.358 ms. These are separate end-to-end observations, not the native benchmark's timing boundary.

Restart recovery resumed an interrupted real run at 78/80 receipts (75 successful): all 75 acknowledged photo IDs and thumbnail timestamps remained unchanged, the final job had 77 vectors, and no work-ledger rows remained. A real native backpressure smoke paused result consumption for two seconds: only 139 thumbnail files existed instead of the full 308. Awaited close finished the last active write in 79 ms (140 files), with no later writes during a one-second observation. Deterministic scheduler/worker regressions additionally cover a blocked early photo with later-than-20 completions, full queues, async callback context, rollback, and cancellation failures.

### Earlier thumbnail optimization

The following measurements precede the continuous-pool change and retain their original baselines.

### Real-photo media and persistence benchmark — 2026-09-19

Release builds ran on Apple M4 Pro, macOS 26.5.1, Bun 1.4.2, Rust 1.98.1 (Homebrew), and ExifTool 13.55. The production photo tree was read-only: 7,961 files comprising 4,796 ARW, 1,232 RAF, 1,181 DNG, 454 HEIC, 277 JPG, 13 JPEG, and 8 PNG. The local stratified sample copied from `/photos/{2025,2026}` contained 80 originals: 12 each of ARW/RAF/DNG/HEIC/JPG/JPEG and all 8 PNG, totaling 1,751,140,174 bytes. This is an over-sampled format comparison, not a throughput measurement of all 7,961 files.

Each variant ran three warm-ish filesystem rounds with isolated file-backed SQLite databases and thumbnail directories:

| Measurement | Baseline | Optimized |
| --- | --- | --- |
| First committed batch | 20 photos | 4 photos |
| Median time to first committed batch | 2,998.371 ms | 732.242 ms |
| Median total native media + persistence time | 11,695.710 ms | 9,329.073 ms |
| Generated thumbnail bytes | 217,897,808 | 32,132,846 |

The first batch committed 4.09x earlier, but its size differs: this is a responsiveness result, not a like-for-like per-photo speedup. Total media time fell 20.24% (1.25x throughput) and thumbnail bytes fell 85.25%. Timings include native media processing and file-backed persistence, not Inngest delivery/checkpoint overhead, network, clients, or embeddings. Warm-ish filesystem rounds do not establish cold-cache performance.

Both versions succeeded on 77 photos; the same three DNG files lack an embedded preview and failed before and after. All 80 source SHA-256 hashes remained unchanged. All 77 successful photos retained equivalent dimensions, pHashes, and EXIF. These checks do not assert pixel-equivalent lossy previews.

### Real local Inngest/API/web smoke — 2026-09-19

A separate actual Inngest/API/web run used the 80-photo sample and the release addon, with a warm model cache. It loaded four real photos in the browser while progress was still `processing` at 4/80, at 1,868.919 ms; 77 photos were listed in the library at 11,752.978 ms, and the job completed with 77 vectors at 19,262.205 ms. The real grid was visually verified. These end-to-end observations are separate from the native/persistence benchmark above, not another baseline/optimized comparison.

During the smoke, 191 HTTP health probes measured a 0.265 ms median, 0.720 ms p95, and 2.606 ms maximum. Source SHA-256, EXIF, dimensions, and pHash checks also passed after this live run. The three DNG failures were unchanged. No mobile native simulator was available; mobile verification was hook/Jest coverage, not a native visual smoke.

Verification completed with 64 API tests, 19 Rust tests, 24 web tests, and 157 mobile tests passing, API/mobile typechecks passing, and changed TypeScript Biome/LSP checks clean. The native release build had no warnings. Full-repository Biome still reported 29 errors, 28 warnings, and 1 informational finding, with the exact counts confirmed on an isolated `git HEAD` baseline; unrelated cleanup was not included. Nothing was deployed, and this was not a full production-library benchmark.

### Scoped persistence and EXIF measurements

`bun run bench:import` from `apps/api` compares file-backed persistence against the previous per-photo write strategy. It does not measure native processing.

`bun run bench:exif <1-20 distinct photo paths>` from `apps/api` compares one metadata command against per-file commands at up to four-way concurrency, using the current Rust metadata flags. It checks exact JSON equivalence, warms both modes, then reports five alternating rounds. Set `EXIFTOOL_BIN` only for this benchmark to select a particular executable. It reads but never modifies the supplied photos.

An isolated CLI experiment in this workspace used ExifTool 13.59, ten small PNGs and ten small JPEG metadata fixtures, with synthetic orientation/camera/exposure/GPS tags. Five alternating warm rounds gave these EXIF-only medians:

| Mode | Processes per 20 files | Median |
| --- | --- | --- |
| Previous per-file pattern, up to four concurrent | 20 | 325.6 ms |
| One batch | 1 | 96.9 ms |

All parsed records matched by `SourceFile`. This is a 3.36x metadata-only improvement on small synthetic inputs, not a camera-corpus or end-to-end speedup. RAW preview subprocesses are additional and unchanged. Real mixed-file CLI checks also confirmed that `-Error` must be requested explicitly and that missing files may have no JSON record at all.

Worker fixture tests use real Bun worker threads with blocking TypeScript to verify timer responsiveness, FIFO reuse, bounded admission, errors, restart, and shutdown; those tests alone do not validate the N-API addon. The release build and real worker/addon lifecycle were exercised by the real-photo benchmark and local Inngest smoke above, replacing the earlier unverified local-native-build limitation.

A broader release-build camera-corpus benchmark should still measure unchanged rescans, one-file changes, artifact repair, and embedding-only recovery separately. Record EXIF, preview/decode, pHash, resize/encode/write, model initialization/image loading/inference, database saves, peak RSS, and API latency. Separate cold/warm filesystem and model caches. The synchronous batch helper's EXIF/media logs do not isolate overlapping streaming stages; embedding timing still includes image loading and model initialization, not just inference.

## Recommended Next Architecture

The largest avoidable rescan cost remains doing media and CLIP work again for unchanged photos. Conservative incremental planning is the next priority before further concurrency increases or streaming embeddings.

### Reliable Identity

Current `modifiedAt` storage truncates timestamps to seconds. Add separate precise source fingerprint fields rather than comparing fresh millisecond timestamps against that field. Include processing/model versions and a source/artifact generation; legacy rows with no fingerprint require a conservative validation pass. Size/mtime, even precise, remains a heuristic: support a deliberate force/deep verification path for preserved-timestamp edits. Define a library/root identity rather than assuming relative paths identify the same files after changing `PHOTO_DIRECTORY`.

Native thumbnail errors now fail readiness, but artifact identity remains unresolved: path naming strips the original extension, so `photo.jpg` and `photo.cr3` collide. Use a collision-free key including full source identity, write an immutable generation, and atomically publish its database pointer only after all required outputs succeed. Migrate serving/RAW fallback/cache keys together; preserve a concrete transition path for existing stored thumbnails. Do not treat file existence alone as current-generation validity.

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

Discovery and per-photo outcomes now live in SQLite, rather than a frozen input-batch plan in Inngest state. Completion checkpoints contain compact counters. The 7,961-file corpus needs 399 result windows plus fixed steps, below the documented 1,000-step ceiling. This is not unbounded scaling: discovery/native sessions still load library-sized path arrays, final successful IDs still enter one embedding event, and embedding lookup still uses one large `IN` query.

Extend the existing manifest with precise source fingerprints, planned actions, and artifact generations. Persist embedding tasks keyed by `(photoId, artifactGeneration, modelVersion)`, plus job membership. Send bounded task IDs rather than library-sized ID lists or vectors. Chunk function runs as well as event payloads; merely splitting the final embedding event does not fix step-count growth.

The current manifest provides immutable membership and durable completion receipts, not source-generation validation, incremental classification, or a distributed ownership lease.

Keep task intent atomic with the existing save transaction. Use an outbox and a real delivery reconciler so a crash between commit and event dispatch cannot strand work. Use stable membership/keyset pagination rather than offsets over a shrinking pending set. Version workflow events/functions or drain active runs before changing replay-sensitive loop membership and checkpoint shapes.

### Ownership and Freshness

Inngest function concurrency limits apply to executing steps, not an exclusive whole-import lifecycle. Different runs can interleave; scan and embedding function limits are separate. The in-process worker limits native resource usage, not database/artifact ownership, and multiple API processes each have their own executor.

Initially coalesce or reject a second active import for the same library using durable ownership with recovery/fencing, including the embedding phase. Every vector/status save must check the expected artifact generation so an older success or failure cannot overwrite newer work. Inference must read an immutable artifact for that generation.

Choose an explicit semantic-search freshness policy. Today old vectors remain searchable while pending/failed regardless of source changes. Strict current-generation search and stale-while-revalidate are different product contracts. Also distinguish retryable model/runtime failure from a permanently unreadable image; current CLIP code turns both into null results.

### Streaming Embeddings Later

Library photos already stream into clients after individual media commits. The proposal below concerns overlapping embedding work with media production, not library visibility.

The preferred longer-term architecture is a durable producer/consumer pipeline: media saves enqueue generation-specific embedding tasks, a bounded consumer fills batches of 16 across producer chunks, and a coordinator owns final job completion. Completion requires discovery closed, media work terminal, and every required embedding task terminal.

Do not emit the existing embedding event after each media batch unchanged: its child finalizes the entire job, so the first child could prematurely finish an ongoing scan. Mobile also assumes monotonic phase order, so alternating processing/embedding phases requires stage counters or a compatible overall phase. Measure time to first searchable photo separately from total throughput.

A separate native execution service is justified only when measured CPU/memory contention or fault isolation requires it. It introduces deployment and shared-storage ownership work and does not remove SQLite's single-writer boundary. The bounded in-process thread is the smaller first step.

## Alternatives Deferred

| Alternative | Potential benefit | Reason not to enable yet |
| --- | --- | --- |
| Persistent ExifTool pool | Further startup amortization, especially RAW | Request framing, binary preview framing, timeouts, child restart/shutdown |
| Deeper resize pyramid or libvips | Further filtering/memory savings beyond the implemented bounded preview reuse | Additional pixel/color/orientation/alpha/HEIF behavior and native deployment validation |
| Smaller CLIP artifact or reduced decode | Less I/O, decode and preprocessing | Preserve crop/color/preprocessing and pHash semantics; version affected outputs |
| More image models or native workers | Possible overlap | Cached image model mutex, runtime threads, memory and API contention must be measured |
| WAL or reduced synchronous mode | Reader/writer coexistence or fewer flushes | Storage compatibility and durability are explicit decisions, not default speed fixes |

## References

- [API implementation guide](../apps/api/AGENTS.md)
- [Native processing guide](../packages/image-processing/AGENTS.md)
- [Database guide](../packages/db/AGENTS.md)
- [Inngest concurrency](https://www.inngest.com/docs/guides/concurrency)
- [Inngest limits](https://www.inngest.com/docs/usage-limits/inngest)
