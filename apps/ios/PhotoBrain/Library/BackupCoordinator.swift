import Foundation

enum BackupAuthorization: Equatable, Sendable {
    case notDetermined
    case denied
    case restricted
    case limited
    case authorized

    var canRead: Bool { self == .limited || self == .authorized }
}

/// The camera roll as the backup uses it; PhotoKit in the app, a fake in tests.
protocol BackupPhotoLibrary: AnyObject, Sendable {
    func authorizationStatus() -> BackupAuthorization
    func requestAuthorization() async -> BackupAuthorization
    /// Image assets, plus video assets when `includeVideos`, with their resources. Slow for
    /// large libraries; never called on the main actor.
    func assets(includeVideos: Bool) -> [BackupAsset]
    /// Writes the original resource for `item` to `file`, downloading it from iCloud if needed.
    func export(_ item: BackupItem, to file: URL) async throws
    func startObserving(_ onChange: @escaping @Sendable () -> Void)
    func stopObserving()
}

enum BackupReconciler {
    static let chunkSize = 1_000

    /// Asks `/uploads/known` about `assetIds` in chunks of 1000 and returns every recorded
    /// resource. Duplicate ids are sent once.
    static func knownKeys(
        api: any BackupServerAPI,
        deviceId: String,
        assetIds: [String]
    ) async throws -> [BackupItemKey] {
        var seen = Set<String>()
        let unique = assetIds.filter { seen.insert($0).inserted }
        var keys: [BackupItemKey] = []
        var start = 0
        while start < unique.count {
            let end = min(start + chunkSize, unique.count)
            let response = try await api.knownUploads(deviceId: deviceId, assetIds: Array(unique[start..<end]))
            for asset in response.assets {
                keys += asset.resources.map { BackupItemKey(assetId: asset.assetId, resource: $0) }
            }
            start = end
        }
        return keys
    }
}

/// Receives the background session's events on its delegate queue. Every completion is written
/// to the ledger here, before (and whether or not) a coordinator is attached, so completions the
/// system delivers to a relaunched app are never lost.
final class BackupSessionEvents: UploadSessionEvents, @unchecked Sendable {
    let processor: BackupCompletionProcessor
    private let lock = NSLock()
    private weak var coordinator: BackupCoordinator?

    init(processor: BackupCompletionProcessor) {
        self.processor = processor
    }

    func attach(_ coordinator: BackupCoordinator) {
        lock.withLock { self.coordinator = coordinator }
    }

    func uploadDidComplete(description: String, status: Int?, body: Data, error: Error?) {
        let result = processor.complete(tempName: description, status: status, body: body, error: error)
        let coordinator = lock.withLock { self.coordinator }
        Task { @MainActor in
            coordinator?.uploadFinished(description: description, result: result)
        }
    }

    func uploadDidProgress(description: String, sent: Int64, expected: Int64) {
        let coordinator = lock.withLock { self.coordinator }
        Task { @MainActor in
            coordinator?.uploadProgressed(description: description, sent: sent, expected: expected)
        }
    }
}

/// Plans and drives camera-roll uploads: at most `maximumConcurrentUploads` files are exported
/// or uploading at once; every outcome is recorded in the ledger before the UI hears about it.
@MainActor
final class BackupCoordinator: ObservableObject {
    struct ActiveUpload: Equatable, Identifiable, Sendable {
        /// The transfer's temporary file name (its task description).
        let id: String
        let filename: String
        var sent: Int64
        var expected: Int64

        var fraction: Double {
            expected > 0 ? min(1, Double(sent) / Double(expected)) : 0
        }
    }

    enum Activity: Equatable, Sendable {
        case idle
        case checkingServer
        case scanningLibrary
        case reconciling
        case uploading
    }

    static let maximumConcurrentUploads = 2

    @Published private(set) var settings: BackupSettings
    @Published private(set) var authorization: BackupAuthorization
    @Published private(set) var activity: Activity = .idle
    @Published private(set) var serverDisabled = false
    @Published private(set) var hasPlanned = false
    @Published private(set) var backedUpAssets = 0
    @Published private(set) var totalAssets = 0
    @Published private(set) var failedFiles = 0
    @Published private(set) var lastError: String?
    @Published private(set) var uploads: [ActiveUpload] = []

    let deviceId: String
    /// Called when a background run should be scheduled (backup enabled, app backgrounded).
    var scheduleBackgroundRun: (() -> Void)?

    private let api: any BackupServerAPI
    private let library: any BackupPhotoLibrary
    private let transport: any UploadTransport
    private let ledger: BackupLedger
    private let processor: BackupCompletionProcessor
    private let settingsStore: BackupSettingsStore
    private let baseURL: URL
    private let temporaryDirectory: URL
    private let now: @Sendable () -> Date
    private let timeZone: () -> TimeZone

    private var config: UploadConfigDTO?
    private var queue: [BackupItem] = []
    private var queueIndex = 0
    private var remainingByAsset: [String: Int] = [:]
    private var skippedFiles = 0
    /// Exports in progress: item key -> temporary file name.
    private var exporting: [BackupItemKey: String] = [:]
    private var runTask: Task<Void, Never>?
    private var rerunRequested = false
    private var retryTask: Task<Void, Never>?
    private var changeTask: Task<Void, Never>?
    private var idleWaiters: [CheckedContinuation<Void, Never>] = []
    private var isObserving = false
    private let changeDebounce: Duration

    init(
        api: any BackupServerAPI,
        library: any BackupPhotoLibrary,
        transport: any UploadTransport,
        events: BackupSessionEvents,
        settingsStore: BackupSettingsStore,
        deviceId: String,
        baseURL: URL,
        now: @escaping @Sendable () -> Date = { Date() },
        timeZone: @escaping () -> TimeZone = { TimeZone.current },
        changeDebounce: Duration = .seconds(3)
    ) {
        self.api = api
        self.library = library
        self.transport = transport
        processor = events.processor
        ledger = events.processor.ledger
        temporaryDirectory = events.processor.temporaryDirectory
        self.settingsStore = settingsStore
        self.deviceId = deviceId
        self.baseURL = baseURL
        self.now = now
        self.timeZone = timeZone
        self.changeDebounce = changeDebounce
        settings = settingsStore.load()
        authorization = library.authorizationStatus()
        events.attach(self)
        refreshFailures()
    }

    var isBusy: Bool {
        runTask != nil || !exporting.isEmpty || !ledger.transfers.isEmpty
    }

    // MARK: - Settings

    /// Turning backup on asks for Photos access first; it stays off when access is refused.
    func setEnabled(_ enabled: Bool) async {
        guard enabled else {
            update { $0.enabled = false }
            stop()
            return
        }
        var status = library.authorizationStatus()
        if status == .notDetermined {
            status = await library.requestAuthorization()
        }
        authorization = status
        guard status.canRead else {
            update { $0.enabled = false }
            return
        }
        update { $0.enabled = true }
        requestRun()
        scheduleBackgroundRun?()
    }

    func setIncludeVideos(_ include: Bool) {
        guard settings.includeVideos != include else { return }
        update { $0.includeVideos = include }
        requestRun()
    }

    func setAllowCellular(_ allow: Bool) {
        update { $0.allowCellular = allow }
    }

    func setDeviceName(_ name: String) {
        let normalized = BackupSettings.normalizedDeviceName(name)
        update { $0.deviceName = normalized }
    }

    private func update(_ mutation: (inout BackupSettings) -> Void) {
        var next = settings
        mutation(&next)
        guard next != settings else { return }
        settings = next
        settingsStore.save(next)
    }

    // MARK: - Triggers

    /// Launch and foreground: refresh the Photos permission, then run.
    func applicationBecameActive() {
        authorization = library.authorizationStatus()
        if settings.enabled && !authorization.canRead {
            stop()
            return
        }
        requestRun()
    }

    func applicationEnteredBackground() {
        if settings.enabled { scheduleBackgroundRun?() }
    }

    /// Back Up Now: retries waiting on backoff become due, and the server is asked again.
    func backUpNow() {
        ledger.makeRetriesDue(now: now())
        lastError = nil
        refreshFailures()
        requestRun()
    }

    /// Coalesces bursts of camera-roll changes into one run.
    func photoLibraryDidChange() {
        changeTask?.cancel()
        changeTask = Task { [weak self, changeDebounce] in
            try? await Task.sleep(for: changeDebounce)
            guard !Task.isCancelled else { return }
            self?.requestRun()
        }
    }

    /// Runs (or joins the current run) and returns once nothing is left to export or upload,
    /// the run failed, the server disabled uploads, or `suspend()` was called.
    func runUntilIdle() async {
        requestRun()
        guard isBusy else { return }
        await withCheckedContinuation { idleWaiters.append($0) }
    }

    /// Stops starting new exports (background time expired). Uploads already handed to the
    /// background session continue and are recorded when they finish.
    func suspend() {
        runTask?.cancel()
        runTask = nil
        queue = []
        queueIndex = 0
        resumeIdleWaiters()
    }

    func requestRun() {
        guard settings.enabled, authorization.canRead else {
            resumeIdleWaiters()
            return
        }
        startObservingIfNeeded()
        if runTask != nil {
            rerunRequested = true
            return
        }
        runTask = Task { [weak self] in
            guard let self else { return }
            repeat {
                rerunRequested = false
                await prepare()
            } while rerunRequested && !Task.isCancelled && settings.enabled
            runTask = nil
            activity = exporting.isEmpty && ledger.transfers.isEmpty ? .idle : .uploading
            checkIdle()
        }
    }

    private func stop() {
        runTask?.cancel()
        runTask = nil
        retryTask?.cancel()
        retryTask = nil
        changeTask?.cancel()
        queue = []
        queueIndex = 0
        transport.cancelAll()
        if isObserving {
            library.stopObserving()
            isObserving = false
        }
        activity = .idle
        resumeIdleWaiters()
    }

    private func startObservingIfNeeded() {
        guard !isObserving else { return }
        isObserving = true
        library.startObserving { [weak self] in
            Task { @MainActor in self?.photoLibraryDidChange() }
        }
    }

    // MARK: - Planning

    private func prepare() async {
        activity = .checkingServer
        let config: UploadConfigDTO
        do {
            config = try await api.uploadConfig()
        } catch {
            if Self.isUploadsDisabled(error) {
                disable()
            } else if !Task.isCancelled {
                lastError = Self.message(for: error)
            }
            return
        }
        guard !Task.isCancelled else { return }
        guard config.enabled else {
            disable()
            return
        }
        self.config = config
        serverDisabled = false
        await pruneLostTransfers()
        removeOrphanedTemporaryFiles()

        activity = .scanningLibrary
        let includeVideos = settings.includeVideos
        let library = library
        let assets = await Task.detached(priority: .utility) {
            library.assets(includeVideos: includeVideos)
        }.value
        guard !Task.isCancelled else { return }

        if !ledger.isReconciled {
            activity = .reconciling
            do {
                let keys = try await BackupReconciler.knownKeys(
                    api: api,
                    deviceId: deviceId,
                    assetIds: assets.map(\.id)
                )
                ledger.reconcile(known: keys)
            } catch {
                if Self.isUploadsDisabled(error) {
                    disable()
                } else if !Task.isCancelled {
                    lastError = Self.message(for: error)
                }
                return
            }
        }
        guard !Task.isCancelled, settings.enabled else { return }

        let plan = BackupPlanner.plan(
            assets: assets,
            includeVideos: includeVideos,
            extensions: Set(config.extensions.map { $0.lowercased() }),
            ledger: ledger.snapshot,
            inFlight: Set(ledger.transfers.values.map(\.key)).union(exporting.keys)
        )
        apply(plan)
        activity = .uploading
        pump()
    }

    private func apply(_ plan: BackupPlan) {
        let current = now()
        var due: [BackupItem] = []
        var nextRetry: Date?
        for item in plan.pending {
            if let retry = ledger.retry(for: item.key), retry.notBefore > current {
                nextRetry = min(nextRetry ?? retry.notBefore, retry.notBefore)
            } else {
                due.append(item)
            }
        }
        queue = due
        queueIndex = 0
        remainingByAsset = plan.remainingByAsset
        skippedFiles = plan.skippedFiles
        totalAssets = plan.totalAssets
        backedUpAssets = plan.backedUpAssets
        hasPlanned = true
        refreshFailures()
        scheduleRetry(at: nextRetry)
    }

    private func scheduleRetry(at date: Date?) {
        retryTask?.cancel()
        retryTask = nil
        guard let date else { return }
        let delay = max(1, date.timeIntervalSince(now()))
        retryTask = Task { [weak self] in
            try? await Task.sleep(for: .seconds(delay))
            guard !Task.isCancelled else { return }
            self?.retryTask = nil
            self?.requestRun()
        }
    }

    /// Transfers recorded before a relaunch whose task the session no longer owns lost their
    /// completion; they become pending again (the server answers a repeat with `200 duplicate`).
    private func pruneLostTransfers() async {
        let recorded = ledger.transfers
        guard !recorded.isEmpty else { return }
        let active = await transport.activeTaskDescriptions()
        for tempName in recorded.keys where !active.contains(tempName) {
            _ = processor.complete(tempName: tempName, status: nil, body: Data(), error: URLError(.cancelled))
            uploads.removeAll { $0.id == tempName }
        }
    }

    private func removeOrphanedTemporaryFiles() {
        let referenced = Set(ledger.transfers.keys).union(exporting.values)
        let files = (try? FileManager.default.contentsOfDirectory(atPath: temporaryDirectory.path)) ?? []
        for name in files where !referenced.contains(name) {
            try? FileManager.default.removeItem(at: temporaryDirectory.appendingPathComponent(name))
        }
    }

    // MARK: - Transfer

    private func pump() {
        guard settings.enabled, !serverDisabled, let config else {
            checkIdle()
            return
        }
        while exporting.count + ledger.transfers.count < Self.maximumConcurrentUploads,
              queueIndex < queue.count {
            let item = queue[queueIndex]
            queueIndex += 1
            let key = item.key
            guard ledger.record(for: key) == nil,
                  exporting[key] == nil,
                  !ledger.transfers.values.contains(where: { $0.key == key }) else { continue }
            startExport(item, config: config)
        }
        checkIdle()
    }

    private func startExport(_ item: BackupItem, config: UploadConfigDTO) {
        let tempName = UUID().uuidString + item.fileExtension
        exporting[item.key] = tempName
        let file = temporaryDirectory.appendingPathComponent(tempName)
        let directory = temporaryDirectory
        let library = library
        Task { [weak self] in
            let exported: Result<Int64, Error> = await Task.detached(priority: .utility) {
                do {
                    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
                    try? FileManager.default.removeItem(at: file)
                    try await library.export(item, to: file)
                    let size = try file.resourceValues(forKeys: [.fileSizeKey]).fileSize ?? 0
                    return .success(Int64(size))
                } catch {
                    return .failure(error)
                }
            }.value
            guard let self else {
                try? FileManager.default.removeItem(at: file)
                return
            }
            finishExport(item, file: file, tempName: tempName, result: exported, config: config)
        }
    }

    private func finishExport(
        _ item: BackupItem,
        file: URL,
        tempName: String,
        result: Result<Int64, Error>,
        config: UploadConfigDTO
    ) {
        exporting[item.key] = nil
        defer { pump() }
        guard settings.enabled, !serverDisabled else {
            try? FileManager.default.removeItem(at: file)
            return
        }
        switch result {
        case let .failure(error):
            try? FileManager.default.removeItem(at: file)
            let message = "Couldn’t read from Photos: \(error.localizedDescription)"
            ledger.recordRetry(item.key, message: message, now: now())
            lastError = "\(item.filename): \(message)"
            refreshFailures()
            scheduleRetryIfIdle(item.key)
        case let .success(size):
            if size == 0 || size > config.maxBytes {
                try? FileManager.default.removeItem(at: file)
                skip(item, reason: size == 0 ? "Empty file" : "Larger than the server's upload limit")
                return
            }
            guard let url = UploadRequestBuilder.url(
                baseURL: baseURL,
                deviceId: deviceId,
                deviceName: settings.deviceName,
                item: item,
                capturedAt: BackupCapturedAtFormatter(timeZone: timeZone())
            ) else {
                try? FileManager.default.removeItem(at: file)
                skip(item, reason: "The upload request could not be created")
                return
            }
            let request = UploadRequestBuilder.request(url: url, allowsCellularAccess: settings.allowCellular)
            ledger.beginTransfer(BackupLedger.Transfer(key: item.key, filename: item.filename, tempName: tempName))
            uploads.append(ActiveUpload(id: tempName, filename: item.filename, sent: 0, expected: size))
            transport.startUpload(request, fromFile: file, description: tempName)
        }
    }

    private func skip(_ item: BackupItem, reason: String) {
        ledger.record(item.key, BackupLedger.Record(status: .skipped, detail: reason))
        skippedFiles += 1
        lastError = "\(item.filename): \(reason)"
        refreshFailures()
    }

    private func scheduleRetryIfIdle(_ key: BackupItemKey) {
        guard retryTask == nil, let retry = ledger.retry(for: key) else { return }
        scheduleRetry(at: retry.notBefore)
    }

    /// A finished upload, already recorded in the ledger by `BackupSessionEvents`.
    func uploadFinished(description: String, result: BackupCompletionProcessor.Result?) {
        uploads.removeAll { $0.id == description }
        defer {
            refreshFailures()
            pump()
        }
        guard let result else { return }
        let name = result.transfer.filename
        switch result.outcome {
        case .done:
            let assetId = result.transfer.key.assetId
            if let remaining = remainingByAsset[assetId] {
                if remaining <= 1 {
                    remainingByAsset[assetId] = nil
                    backedUpAssets = min(totalAssets, backedUpAssets + 1)
                } else {
                    remainingByAsset[assetId] = remaining - 1
                }
            }
        case let .skipped(reason):
            skippedFiles += 1
            lastError = "\(name): \(reason)"
        case let .retry(message):
            lastError = "\(name): \(message)"
            scheduleRetryIfIdle(result.transfer.key)
        case .disabled:
            disable()
        case .cancelled:
            break
        }
    }

    func uploadProgressed(description: String, sent: Int64, expected: Int64) {
        guard let index = uploads.firstIndex(where: { $0.id == description }) else { return }
        uploads[index].sent = sent
        if expected > 0 { uploads[index].expected = expected }
    }

    /// `503 UPLOADS_DISABLED`: nothing new starts and in-flight uploads are cancelled; their
    /// items stay pending for the next run.
    private func disable() {
        serverDisabled = true
        queue = []
        queueIndex = 0
        transport.cancelAll()
        activity = .idle
        resumeIdleWaiters()
    }

    private func refreshFailures() {
        let retries = ledger.retries
        failedFiles = retries.count + skippedFiles
        if lastError == nil, let retry = retries.values.max(by: { $0.failedAt < $1.failedAt }) {
            lastError = retry.message
        }
    }

    private func checkIdle() {
        guard runTask == nil, exporting.isEmpty else { return }
        let drained = queueIndex >= queue.count || serverDisabled || !settings.enabled
        guard drained, ledger.transfers.isEmpty else { return }
        uploads = []
        activity = .idle
        resumeIdleWaiters()
    }

    private func resumeIdleWaiters() {
        let waiters = idleWaiters
        idleWaiters = []
        waiters.forEach { $0.resume() }
    }

    private static func isUploadsDisabled(_ error: Error) -> Bool {
        if case let .server(status, code, _) = error as? PhotoBrainAPIError {
            return status == 503 && code == "UPLOADS_DISABLED"
        }
        return false
    }

    private static func message(for error: Error) -> String {
        (error as? LocalizedError)?.errorDescription ?? error.localizedDescription
    }
}
