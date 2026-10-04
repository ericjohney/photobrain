import Foundation

/// Downloads one export at a time for the share sheet and owns its temporary file until the
/// sheet finishes: `idle -> downloading -> ready(file) -> idle`, or `downloading -> failed`.
/// Cancelling or failing leaves no file; a file that finishes after a cancel, or after the store
/// is released, is deleted.
@MainActor
final class ExportStore: ObservableObject {
    enum State: Equatable {
        case idle
        /// `progress` is nil until the first bytes arrive.
        case downloading(ExportTarget, progress: ExportProgress?)
        /// Downloaded and waiting for the share sheet; removed by `finishSharing()`.
        case ready(ExportFile)
        case failed(Failure)
    }

    struct Failure: Equatable {
        let message: String
        /// Set when repeating the same export may succeed (busy server, lost connection);
        /// shown as Retry. Never retried automatically.
        let retryTarget: ExportTarget?
    }

    @Published private(set) var state: State = .idle

    private let api: any PhotoBrainAPI
    private let owned = Owned()
    /// Bumped by every start and cancel; results and progress of older downloads are discarded.
    private var generation = 0

    init(api: any PhotoBrainAPI) {
        self.api = api
    }

    deinit {
        owned.release()
    }

    /// True while a download runs or its file awaits the share sheet; new exports are ignored.
    var isBusy: Bool {
        switch state {
        case .downloading, .ready: true
        case .idle, .failed: false
        }
    }

    var readyFile: ExportFile? {
        guard case let .ready(file) = state else { return nil }
        return file
    }

    func start(_ target: ExportTarget) {
        guard !isBusy else { return }
        generation += 1
        let requestGeneration = generation
        state = .downloading(target, progress: nil)
        let progressSink = ProgressSink(store: self, generation: requestGeneration)
        owned.task = Task { [api, weak self] in
            do {
                let file = try await api.download(target) { progress in
                    progressSink.send(progress)
                }
                guard let self, requestGeneration == self.generation else {
                    file.remove()
                    return
                }
                self.owned.task = nil
                self.owned.file = file
                self.state = .ready(file)
            } catch {
                guard let self, requestGeneration == self.generation else { return }
                self.owned.task = nil
                self.state = error is CancellationError
                    ? .idle
                    : .failed(Failure(
                        message: Self.message(for: error),
                        retryTarget: (error as? PhotoBrainAPIError)?.isRetryable == true ? target : nil
                    ))
            }
        }
    }

    /// Stops a running download; the client deletes its partial file.
    func cancel() {
        guard case .downloading = state else { return }
        generation += 1
        owned.task?.cancel()
        owned.task = nil
        state = .idle
    }

    /// Called when the share sheet completes or fails to present: deletes the shared file.
    func finishSharing() {
        guard case let .ready(file) = state else { return }
        file.remove()
        owned.file = nil
        state = .idle
    }

    func dismissError() {
        guard case .failed = state else { return }
        state = .idle
    }

    /// Repeats a retryable failed export.
    func retry() {
        guard case let .failed(failure) = state, let target = failure.retryTarget else { return }
        state = .idle
        start(target)
    }

    private func apply(_ progress: ExportProgress, generation progressGeneration: Int) {
        guard progressGeneration == generation,
              case let .downloading(target, current) = state,
              progress.received >= (current?.received ?? 0) else { return }
        state = .downloading(target, progress: progress)
    }

    static func message(for error: Error) -> String {
        (error as? LocalizedError)?.errorDescription ?? error.localizedDescription
    }

    /// The running download and unshared file, reachable from the nonisolated `deinit`.
    private final class Owned: @unchecked Sendable {
        private let lock = NSLock()
        private var _task: Task<Void, Never>?
        private var _file: ExportFile?

        var task: Task<Void, Never>? {
            get { lock.withLock { _task } }
            set { lock.withLock { _task = newValue } }
        }

        var file: ExportFile? {
            get { lock.withLock { _file } }
            set { lock.withLock { _file = newValue } }
        }

        func release() {
            let (task, file) = lock.withLock { (_task, _file) }
            task?.cancel()
            file?.remove()
        }
    }

    /// Forwards download progress to the main actor without retaining the store.
    private struct ProgressSink: Sendable {
        weak var store: ExportStore?
        let generation: Int

        func send(_ progress: ExportProgress) {
            Task { @MainActor [store, generation] in
                store?.apply(progress, generation: generation)
            }
        }
    }
}
