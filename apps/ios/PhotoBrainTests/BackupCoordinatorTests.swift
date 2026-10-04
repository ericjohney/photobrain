import XCTest
@testable import PhotoBrain

actor FakeBackupServer: BackupServerAPI {
    var config: Result<UploadConfigDTO, PhotoBrainAPIError> = .success(UploadConfigDTO(
        enabled: true,
        maxBytes: 1_000_000,
        extensions: Array(BackupFixtures.extensions)
    ))
    private var known: [String: [UploadResource]] = [:]
    private(set) var knownRequests: [[String]] = []
    private(set) var configRequests = 0

    func setConfig(_ config: Result<UploadConfigDTO, PhotoBrainAPIError>) {
        self.config = config
    }

    func setKnown(_ known: [String: [UploadResource]]) {
        self.known = known
    }

    func uploadConfig() async throws -> UploadConfigDTO {
        configRequests += 1
        return try config.get()
    }

    func knownUploads(deviceId: String, assetIds: [String]) async throws -> KnownUploadsResponseDTO {
        knownRequests.append(assetIds)
        if case let .failure(error) = config { throw error }
        return KnownUploadsResponseDTO(assets: assetIds.compactMap { id in
            known[id].map { KnownUploadsResponseDTO.Asset(assetId: id, resources: $0) }
        })
    }
}

final class FakePhotoLibrary: BackupPhotoLibrary, @unchecked Sendable {
    private let lock = NSLock()
    private var _assets: [BackupAsset] = []
    private var _authorization: BackupAuthorization
    private var _requestResult: BackupAuthorization
    private var _exported: [BackupItemKey] = []
    private var _observer: (@Sendable () -> Void)?
    private(set) var authorizationRequests = 0

    init(authorization: BackupAuthorization = .authorized, requestResult: BackupAuthorization = .authorized) {
        _authorization = authorization
        _requestResult = requestResult
    }

    var assetList: [BackupAsset] {
        get { lock.withLock { _assets } }
        set { lock.withLock { _assets = newValue } }
    }

    var exported: [BackupItemKey] { lock.withLock { _exported } }

    func authorizationStatus() -> BackupAuthorization { lock.withLock { _authorization } }

    func requestAuthorization() async -> BackupAuthorization {
        lock.withLock {
            authorizationRequests += 1
            _authorization = _requestResult
            return _authorization
        }
    }

    func assets(includeVideos: Bool) -> [BackupAsset] {
        assetList.filter { includeVideos || !$0.isVideo }
    }

    func export(_ item: BackupItem, to file: URL) async throws {
        lock.withLock { _exported.append(item.key) }
        try Data(repeating: 7, count: 32).write(to: file)
    }

    func startObserving(_ onChange: @escaping @Sendable () -> Void) {
        lock.withLock { _observer = onChange }
    }

    func stopObserving() {
        lock.withLock { _observer = nil }
    }

    func simulateChange() {
        lock.withLock { _observer }?()
    }
}

/// Records uploads instead of sending them; completions are delivered by the test through the
/// same `BackupSessionEvents` the background session would call.
final class FakeUploadTransport: UploadTransport, @unchecked Sendable {
    struct Upload {
        let request: URLRequest
        let file: URL
        let description: String
        let fileExisted: Bool
    }

    weak var events: BackupSessionEvents?
    private let lock = NSLock()
    private var _uploads: [Upload] = []
    private var _active: Set<String>
    private(set) var cancelAllCalls = 0

    init(active: Set<String> = []) {
        _active = active
    }

    var uploads: [Upload] { lock.withLock { _uploads } }
    var active: Set<String> { lock.withLock { _active } }

    /// The upload for `assetId` (export completion order is not deterministic).
    func upload(for assetId: String) -> Upload? {
        uploads.first { upload in
            URLComponents(url: upload.request.url!, resolvingAgainstBaseURL: false)?
                .queryItems?.first { $0.name == "assetId" }?.value == assetId
        }
    }

    func startUpload(_ request: URLRequest, fromFile file: URL, description: String) {
        let upload = Upload(
            request: request,
            file: file,
            description: description,
            fileExisted: FileManager.default.fileExists(atPath: file.path)
        )
        lock.withLock {
            _uploads.append(upload)
            _active.insert(description)
        }
    }

    func activeTaskDescriptions() async -> Set<String> { active }

    func cancelAll() {
        let cancelled = lock.withLock {
            cancelAllCalls += 1
            defer { _active = [] }
            return _active
        }
        for description in cancelled {
            events?.uploadDidComplete(description: description, status: nil, body: Data(), error: URLError(.cancelled))
        }
    }

    /// Delivers a response for `description` as the background session would.
    func finish(_ description: String, status: Int?, body: Data = Data(), error: Error? = nil) {
        lock.withLock { _ = _active.remove(description) }
        events?.uploadDidComplete(description: description, status: status, body: body, error: error)
    }
}

@MainActor
final class BackupCoordinatorTests: XCTestCase {
    private let deviceId = "6f1c2a8e-3a5b-4c55-9b1e-1f3a3c2d4e5f"
    private var directory: URL!
    private var suite: String!
    private var defaults: UserDefaults!

    override func setUp() async throws {
        try await super.setUp()
        directory = BackupFixtures.temporaryDirectory()
        suite = "BackupCoordinatorTests-\(UUID().uuidString)"
        defaults = UserDefaults(suiteName: suite)
    }

    override func tearDown() async throws {
        defaults.removePersistentDomain(forName: suite)
        try? FileManager.default.removeItem(at: directory)
        try await super.tearDown()
    }

    private var ledgerURL: URL { directory.appendingPathComponent("ledger.jsonl") }
    private var tempDirectory: URL { directory.appendingPathComponent("Uploads", isDirectory: true) }

    private struct Harness {
        let coordinator: BackupCoordinator
        let events: BackupSessionEvents
        let ledger: BackupLedger
        let transport: FakeUploadTransport
    }

    private func makeHarness(
        server: FakeBackupServer,
        library: FakePhotoLibrary,
        transport: FakeUploadTransport = FakeUploadTransport(),
        settings: BackupSettings? = BackupSettings(enabled: true)
    ) -> Harness {
        let store = BackupSettingsStore(defaults: defaults)
        if let settings { store.save(settings) }
        let ledger = BackupLedger(fileURL: ledgerURL, deviceId: deviceId)
        let events = BackupSessionEvents(
            processor: BackupCompletionProcessor(ledger: ledger, temporaryDirectory: tempDirectory)
        )
        transport.events = events
        let coordinator = BackupCoordinator(
            api: server,
            library: library,
            transport: transport,
            events: events,
            settingsStore: store,
            deviceId: deviceId,
            baseURL: URL(string: "https://photos.example.test")!,
            timeZone: { TimeZone(secondsFromGMT: 0)! },
            changeDebounce: .milliseconds(10)
        )
        return Harness(coordinator: coordinator, events: events, ledger: ledger, transport: transport)
    }

    private func photo(_ id: String, _ created: TimeInterval, _ name: String) -> BackupAsset {
        BackupFixtures.asset(id, created: created, [(.photo, name)])
    }

    private func query(_ upload: FakeUploadTransport.Upload) -> [String: String] {
        let items = URLComponents(url: upload.request.url!, resolvingAgainstBaseURL: false)?.queryItems ?? []
        return Dictionary(uniqueKeysWithValues: items.map { ($0.name, $0.value ?? "") })
    }

    // MARK: - Enabling

    func testEnablingRequestsPhotosAccessAndDenialKeepsBackupOff() async {
        let library = FakePhotoLibrary(authorization: .notDetermined, requestResult: .denied)
        let harness = makeHarness(server: FakeBackupServer(), library: library, settings: nil)
        XCTAssertEqual(harness.coordinator.settings, BackupSettings())
        await harness.coordinator.setEnabled(true)
        XCTAssertEqual(library.authorizationRequests, 1)
        XCTAssertEqual(harness.coordinator.authorization, .denied)
        XCTAssertFalse(harness.coordinator.settings.enabled)
        XCTAssertFalse(BackupSettingsStore(defaults: defaults).load().enabled)
    }

    func testLimitedAccessEnablesBackup() async throws {
        let library = FakePhotoLibrary(authorization: .notDetermined, requestResult: .limited)
        library.assetList = [photo("a", 1, "A.HEIC")]
        let harness = makeHarness(server: FakeBackupServer(), library: library, settings: nil)
        await harness.coordinator.setEnabled(true)
        XCTAssertTrue(harness.coordinator.settings.enabled)
        XCTAssertEqual(harness.coordinator.authorization, .limited)
        try await waitUntil { harness.transport.uploads.count == 1 }
    }

    // MARK: - Planning and transfer

    func testFirstRunReconcilesThenUploadsNewestFirstTwoAtATime() async throws {
        let server = FakeBackupServer()
        await server.setKnown(["known": [.photo]])
        let library = FakePhotoLibrary()
        library.assetList = [
            photo("known", 400, "K.HEIC"),
            photo("old", 100, "O.HEIC"),
            photo("new", 300, "N.HEIC"),
            photo("mid", 200, "M.HEIC"),
            BackupFixtures.asset("gif", created: 500, [(.photo, "G.GIF")]),
        ]
        let harness = makeHarness(server: server, library: library)
        var createdNotifications = 0
        harness.coordinator.onFileCreated = { createdNotifications += 1 }
        harness.coordinator.requestRun()

        try await waitUntil { harness.transport.uploads.count == 2 }
        try await Task.sleep(for: .milliseconds(100))
        XCTAssertEqual(harness.transport.uploads.count, 2, "at most two uploads at once")
        let reconciled = await server.knownRequests
        XCTAssertEqual(reconciled, [["known", "old", "new", "mid", "gif"]])
        XCTAssertTrue(harness.ledger.isReconciled)
        XCTAssertEqual(harness.coordinator.totalAssets, 4)
        XCTAssertEqual(harness.coordinator.backedUpAssets, 1)
        XCTAssertEqual(Set(harness.coordinator.uploads.map(\.filename)), ["N.HEIC", "M.HEIC"])

        let first = try XCTUnwrap(harness.transport.upload(for: "new"))
        XCTAssertTrue(first.fileExisted)
        XCTAssertEqual(first.request.httpMethod, "POST")
        XCTAssertEqual(first.request.url?.path, "/api/v1/uploads")
        XCTAssertFalse(first.request.allowsCellularAccess)
        XCTAssertEqual(query(first), [
            "deviceId": deviceId,
            "deviceName": "iPhone",
            "filename": "N.HEIC",
            "assetId": "new",
            "resource": "photo",
            "capturedAt": "1970-01-01T00:05:00Z",
        ])

        harness.transport.finish(first.description, status: 201, body: BackupFixtures.created("Uploads/iPhone/1970/01/N.HEIC"))
        try await waitUntil { harness.transport.uploads.count == 3 }
        XCTAssertFalse(FileManager.default.fileExists(atPath: first.file.path), "temp file deleted")
        let old = try XCTUnwrap(harness.transport.upload(for: "old"))
        XCTAssertTrue(old.description.hasSuffix(".heic"))

        let mid = try XCTUnwrap(harness.transport.upload(for: "mid"))
        harness.transport.finish(mid.description, status: 200, body: BackupFixtures.duplicate("2019/M.HEIC"))
        harness.transport.finish(old.description, status: 201, body: BackupFixtures.created("Uploads/iPhone/1970/01/O.HEIC"))
        try await waitUntil { harness.coordinator.activity == .idle && harness.coordinator.uploads.isEmpty }
        XCTAssertEqual(harness.coordinator.backedUpAssets, 4)
        XCTAssertEqual(harness.coordinator.failedFiles, 0)
        XCTAssertEqual(harness.ledger.record(for: BackupItemKey(assetId: "mid", resource: .photo)), .init(status: .uploaded, detail: "2019/M.HEIC"))
        XCTAssertEqual(harness.transport.uploads.count, 3)
        XCTAssertEqual(createdNotifications, 2, "only created files (not duplicates) expect an import")
        XCTAssertFalse(library.exported.contains(BackupItemKey(assetId: "known", resource: .photo)))

        // A second run skips everything recorded locally and does not reconcile again.
        harness.coordinator.backUpNow()
        try await waitUntil { await server.configRequests == 2 }
        try await waitUntil { harness.coordinator.activity == .idle }
        XCTAssertEqual(harness.transport.uploads.count, 3)
        let afterSecondRun = await server.knownRequests
        XCTAssertEqual(afterSecondRun.count, 1)
    }

    func testVideosAreLeftOutWhenTheToggleIsOffAndCellularFollowsTheSetting() async throws {
        let library = FakePhotoLibrary()
        library.assetList = [
            BackupFixtures.asset("video", created: 2, video: true, [(.video, "V.MOV")]),
            photo("photo", 1, "P.HEIC"),
        ]
        let harness = makeHarness(
            server: FakeBackupServer(),
            library: library,
            settings: BackupSettings(enabled: true, includeVideos: false, allowCellular: true, deviceName: "Eric's iPhone")
        )
        harness.coordinator.requestRun()
        try await waitUntil { harness.transport.uploads.count == 1 }
        try await Task.sleep(for: .milliseconds(100))
        XCTAssertEqual(harness.transport.uploads.count, 1)
        let upload = harness.transport.uploads[0]
        XCTAssertEqual(query(upload)["assetId"], "photo")
        XCTAssertEqual(query(upload)["deviceName"], "Eric's iPhone")
        XCTAssertTrue(upload.request.allowsCellularAccess)
        XCTAssertEqual(harness.coordinator.totalAssets, 1)

        harness.coordinator.setIncludeVideos(true)
        try await waitUntil { harness.transport.uploads.count == 2 }
        XCTAssertEqual(query(harness.transport.uploads[1])["resource"], "video")
    }

    func testUploadsDisabledFromConfigShowsDisabledWithoutUploading() async throws {
        let server = FakeBackupServer()
        await server.setConfig(.failure(.server(status: 503, code: "UPLOADS_DISABLED", message: "Uploads are disabled")))
        let library = FakePhotoLibrary()
        library.assetList = [photo("a", 1, "A.HEIC")]
        let harness = makeHarness(server: server, library: library)
        await harness.coordinator.runUntilIdle()
        XCTAssertTrue(harness.coordinator.serverDisabled)
        XCTAssertTrue(harness.transport.uploads.isEmpty)
        let known = await server.knownRequests
        XCTAssertTrue(known.isEmpty)

        // `enabled: false` in a 200 config is treated the same way.
        await server.setConfig(.success(UploadConfigDTO(enabled: false, maxBytes: 1, extensions: [".heic"])))
        harness.coordinator.backUpNow()
        try await waitUntil { await server.configRequests == 2 }
        try await waitUntil { harness.coordinator.activity == .idle }
        XCTAssertTrue(harness.coordinator.serverDisabled)

        // Re-enabled on the server: the next run uploads.
        await server.setConfig(.success(UploadConfigDTO(enabled: true, maxBytes: 1_000, extensions: [".heic"])))
        harness.coordinator.backUpNow()
        try await waitUntil { harness.transport.uploads.count == 1 }
        XCTAssertFalse(harness.coordinator.serverDisabled)
    }

    func testUploadsDisabledResponseStopsTheQueue() async throws {
        let library = FakePhotoLibrary()
        library.assetList = (0..<5).map { photo("a\($0)", TimeInterval(10 - $0), "A\($0).HEIC") }
        let harness = makeHarness(server: FakeBackupServer(), library: library)
        harness.coordinator.requestRun()
        try await waitUntil { harness.transport.uploads.count == 2 }

        harness.transport.finish(
            harness.transport.uploads[0].description,
            status: 503,
            body: BackupFixtures.error("UPLOADS_DISABLED", "Uploads are disabled")
        )
        try await waitUntil { harness.coordinator.serverDisabled }
        try await waitUntil { harness.ledger.transfers.isEmpty }
        try await Task.sleep(for: .milliseconds(100))
        XCTAssertEqual(harness.transport.uploads.count, 2, "nothing new starts")
        XCTAssertEqual(harness.transport.cancelAllCalls, 1, "the other in-flight upload is cancelled")
        XCTAssertTrue(harness.ledger.snapshot.records.isEmpty, "items stay pending")
        XCTAssertTrue(harness.ledger.retries.isEmpty, "no backoff for a disabled server")
        XCTAssertEqual(harness.coordinator.activity, .idle)
    }

    func testSkipsAndRetriesAreCountedAndBackUpNowRetries() async throws {
        let library = FakePhotoLibrary()
        library.assetList = [photo("big", 2, "B.HEIC"), photo("full", 1, "F.HEIC")]
        let harness = makeHarness(server: FakeBackupServer(), library: library)
        harness.coordinator.requestRun()
        try await waitUntil { harness.transport.uploads.count == 2 }

        let big = try XCTUnwrap(harness.transport.upload(for: "big"))
        let full = try XCTUnwrap(harness.transport.upload(for: "full"))
        harness.transport.finish(big.description, status: 413, body: BackupFixtures.error("UPLOAD_TOO_LARGE"))
        harness.transport.finish(full.description, status: 507, body: BackupFixtures.error("INSUFFICIENT_STORAGE"))
        try await waitUntil { harness.coordinator.failedFiles == 2 }
        XCTAssertEqual(
            harness.ledger.record(for: BackupItemKey(assetId: "big", resource: .photo)),
            .init(status: .skipped, detail: "Larger than the server's upload limit")
        )
        XCTAssertEqual(harness.ledger.retry(for: BackupItemKey(assetId: "full", resource: .photo))?.attempts, 1)
        XCTAssertNotNil(harness.coordinator.lastError)

        // Network failure on the retry, then success.
        harness.coordinator.backUpNow()
        try await waitUntil { harness.transport.uploads.count == 3 }
        XCTAssertEqual(query(harness.transport.uploads[2])["assetId"], "full")
        harness.transport.finish(harness.transport.uploads[2].description, status: nil, error: URLError(.networkConnectionLost))
        try await waitUntil { harness.ledger.retry(for: BackupItemKey(assetId: "full", resource: .photo))?.attempts == 2 }

        harness.coordinator.backUpNow()
        try await waitUntil { harness.transport.uploads.count == 4 }
        harness.transport.finish(harness.transport.uploads[3].description, status: 201, body: BackupFixtures.created("Uploads/iPhone/F.HEIC"))
        try await waitUntil { harness.ledger.record(for: BackupItemKey(assetId: "full", resource: .photo))?.status == .uploaded }
        try await waitUntil { harness.coordinator.failedFiles == 1 }
        XCTAssertEqual(harness.transport.uploads.count, 4, "the skipped file is never retried")
    }

    func testRetriesWaitForTheirBackoff() async throws {
        let library = FakePhotoLibrary()
        library.assetList = [photo("a", 1, "A.HEIC")]
        let harness = makeHarness(server: FakeBackupServer(), library: library)
        harness.ledger.recordRetry(BackupItemKey(assetId: "a", resource: .photo), message: "Offline", now: Date())
        await harness.coordinator.runUntilIdle()
        XCTAssertTrue(harness.transport.uploads.isEmpty)
        XCTAssertEqual(harness.coordinator.failedFiles, 1)
        XCTAssertEqual(harness.coordinator.lastError, "Offline")
    }

    func testPhotoLibraryChangesStartARun() async throws {
        let library = FakePhotoLibrary()
        let harness = makeHarness(server: FakeBackupServer(), library: library)
        await harness.coordinator.runUntilIdle()
        XCTAssertTrue(harness.transport.uploads.isEmpty)

        library.assetList = [photo("new", 1, "NEW.HEIC")]
        library.simulateChange()
        try await waitUntil { harness.transport.uploads.count == 1 }
        XCTAssertEqual(query(harness.transport.uploads[0])["filename"], "NEW.HEIC")
    }

    func testDisablingCancelsUploadsAndKeepsItemsPending() async throws {
        let library = FakePhotoLibrary()
        library.assetList = [photo("a", 1, "A.HEIC")]
        let harness = makeHarness(server: FakeBackupServer(), library: library)
        harness.coordinator.requestRun()
        try await waitUntil { harness.transport.uploads.count == 1 }
        await harness.coordinator.setEnabled(false)
        try await waitUntil { harness.ledger.transfers.isEmpty }
        XCTAssertEqual(harness.transport.cancelAllCalls, 1)
        XCTAssertNil(harness.ledger.record(for: BackupItemKey(assetId: "a", resource: .photo)))
        XCTAssertFalse(BackupSettingsStore(defaults: defaults).load().enabled)
    }

    // MARK: - Relaunch

    func testCompletionDeliveredAfterRelaunchIsRecordedAndNotReuploaded() async throws {
        try FileManager.default.createDirectory(at: tempDirectory, withIntermediateDirectories: true)
        let previous = BackupLedger(fileURL: ledgerURL, deviceId: deviceId)
        previous.reconcile(known: [])
        let inFlight = BackupItemKey(assetId: "a", resource: .photo)
        let delivered = BackupItemKey(assetId: "b", resource: .photo)
        previous.beginTransfer(.init(key: inFlight, filename: "A.HEIC", tempName: "T-A.heic"))
        previous.beginTransfer(.init(key: delivered, filename: "B.HEIC", tempName: "T-B.heic"))
        try Data([1]).write(to: tempDirectory.appendingPathComponent("T-A.heic"))
        try Data([1]).write(to: tempDirectory.appendingPathComponent("T-B.heic"))

        let library = FakePhotoLibrary()
        library.assetList = [photo("a", 3, "A.HEIC"), photo("b", 2, "B.HEIC"), photo("c", 1, "C.HEIC")]
        let transport = FakeUploadTransport(active: ["T-A.heic"])
        let harness = makeHarness(server: FakeBackupServer(), library: library, transport: transport)

        // The system relaunches the app and delivers a queued completion before any UI exists.
        harness.events.uploadDidComplete(
            description: "T-B.heic",
            status: 201,
            body: BackupFixtures.created("Uploads/iPhone/B.HEIC"),
            error: nil
        )
        XCTAssertEqual(harness.ledger.record(for: delivered)?.detail, "Uploads/iPhone/B.HEIC")
        XCTAssertFalse(FileManager.default.fileExists(atPath: tempDirectory.appendingPathComponent("T-B.heic").path))

        harness.coordinator.requestRun()
        try await waitUntil { transport.uploads.count == 1 }
        try await Task.sleep(for: .milliseconds(100))
        XCTAssertEqual(transport.uploads.map { query($0)["assetId"] }, ["c"], "only the never-sent asset uploads")
        XCTAssertTrue(FileManager.default.fileExists(atPath: tempDirectory.appendingPathComponent("T-A.heic").path))

        transport.finish("T-A.heic", status: 200, body: BackupFixtures.duplicate("Uploads/iPhone/A.HEIC"))
        try await waitUntil { harness.ledger.record(for: inFlight)?.status == .uploaded }

        let relaunched = BackupLedger(fileURL: ledgerURL, deviceId: deviceId)
        XCTAssertEqual(relaunched.record(for: inFlight)?.status, .uploaded)
        XCTAssertEqual(relaunched.record(for: delivered)?.status, .uploaded)
        XCTAssertEqual(Set(relaunched.transfers.keys), [transport.uploads[0].description])
    }

    func testTransferLostAcrossRelaunchIsUploadedAgain() async throws {
        try FileManager.default.createDirectory(at: tempDirectory, withIntermediateDirectories: true)
        let previous = BackupLedger(fileURL: ledgerURL, deviceId: deviceId)
        previous.reconcile(known: [])
        previous.beginTransfer(.init(key: BackupItemKey(assetId: "a", resource: .photo), filename: "A.HEIC", tempName: "LOST.heic"))
        try Data([1]).write(to: tempDirectory.appendingPathComponent("LOST.heic"))
        try Data([1]).write(to: tempDirectory.appendingPathComponent("ORPHAN.heic"))

        let library = FakePhotoLibrary()
        library.assetList = [photo("a", 1, "A.HEIC")]
        let harness = makeHarness(server: FakeBackupServer(), library: library, transport: FakeUploadTransport(active: []))
        harness.coordinator.requestRun()
        try await waitUntil { harness.transport.uploads.count == 1 }
        XCTAssertEqual(query(harness.transport.uploads[0])["assetId"], "a")
        XCTAssertNotEqual(harness.transport.uploads[0].description, "LOST.heic")
        XCTAssertFalse(FileManager.default.fileExists(atPath: tempDirectory.appendingPathComponent("LOST.heic").path))
        XCTAssertFalse(FileManager.default.fileExists(atPath: tempDirectory.appendingPathComponent("ORPHAN.heic").path))
        XCTAssertNil(harness.ledger.retry(for: BackupItemKey(assetId: "a", resource: .photo)))
    }
}

@MainActor
private func waitUntil(
    timeout: Duration = .seconds(3),
    file: StaticString = #filePath,
    line: UInt = #line,
    _ condition: @MainActor () async -> Bool
) async throws {
    let deadline = ContinuousClock.now + timeout
    while !(await condition()) {
        guard ContinuousClock.now < deadline else {
            XCTFail("Condition not met before timeout", file: file, line: line)
            return
        }
        try await Task.sleep(for: .milliseconds(10))
    }
}
