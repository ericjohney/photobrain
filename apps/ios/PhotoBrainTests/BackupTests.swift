import XCTest
@testable import PhotoBrain

enum BackupFixtures {
    static func asset(
        _ id: String,
        created: TimeInterval?,
        video: Bool = false,
        _ resources: [(PhotoKitResourceKind, String)]
    ) -> BackupAsset {
        BackupAsset(
            id: id,
            creationDate: created.map(Date.init(timeIntervalSince1970:)),
            isVideo: video,
            resources: resources.map { BackupAssetResource(kind: $0.0, filename: $0.1) }
        )
    }

    static let extensions: Set<String> = [".heic", ".jpg", ".dng", ".mov", ".mp4"]

    static func temporaryDirectory() -> URL {
        let url = FileManager.default.temporaryDirectory
            .appendingPathComponent("BackupTests-\(UUID().uuidString)", isDirectory: true)
        try? FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
        return url
    }

    static func created(_ path: String, size: Int = 10) -> Data {
        Data(#"{"status":"created","path":"\#(path)","size":\#(size)}"#.utf8)
    }

    static func duplicate(_ path: String, size: Int = 10) -> Data {
        Data(#"{"status":"duplicate","path":"\#(path)","size":\#(size)}"#.utf8)
    }

    static func error(_ code: String, _ message: String = "Rejected") -> Data {
        Data(#"{"error":{"code":"\#(code)","message":"\#(message)"}}"#.utf8)
    }
}

final class BackupResourceSelectionTests: XCTestCase {
    func testPhotoPrefersPhotoOverFullSizePhoto() {
        let asset = BackupFixtures.asset("a", created: 1, [
            (.fullSizePhoto, "FullSizeRender.heic"),
            (.photo, "IMG_0001.HEIC"),
        ])
        let items = BackupResourceSelector.items(for: asset)
        XCTAssertEqual(items.map(\.resource), [.photo])
        XCTAssertEqual(items.first?.sourceKind, .photo)
        XCTAssertEqual(items.first?.filename, "IMG_0001.HEIC")
    }

    func testFullSizePhotoIsUsedOnlyWithoutPhoto() {
        let asset = BackupFixtures.asset("a", created: 1, [(.fullSizePhoto, "IMG_0002.JPG")])
        let items = BackupResourceSelector.items(for: asset)
        XCTAssertEqual(items.map(\.resource), [.photo])
        XCTAssertEqual(items.first?.sourceKind, .fullSizePhoto)
    }

    func testRawLivePhotoAndVideoResourcesInUploadOrder() {
        let raw = BackupFixtures.asset("raw", created: 1, [
            (.alternatePhoto, "IMG_0003.DNG"),
            (.photo, "IMG_0003.JPG"),
        ])
        XCTAssertEqual(BackupResourceSelector.items(for: raw).map(\.resource), [.photo, .alternatePhoto])

        let live = BackupFixtures.asset("live", created: 1, [
            (.pairedVideo, "IMG_0004.MOV"),
            (.photo, "IMG_0004.HEIC"),
            (.other, "Adjustments.plist"),
        ])
        let liveItems = BackupResourceSelector.items(for: live)
        XCTAssertEqual(liveItems.map(\.resource), [.photo, .pairedVideo])
        XCTAssertEqual(liveItems.map(\.filename), ["IMG_0004.HEIC", "IMG_0004.MOV"])

        let video = BackupFixtures.asset("video", created: 1, video: true, [
            (.video, "IMG_0005.MOV"),
            (.other, "FullSizeRender.mov"),
        ])
        XCTAssertEqual(BackupResourceSelector.items(for: video).map(\.resource), [.video])
    }

    func testEditedAndAuxiliaryResourcesAreIgnored() {
        let asset = BackupFixtures.asset("a", created: 1, [(.other, "FullSizeRender.heic")])
        XCTAssertEqual(BackupResourceSelector.items(for: asset), [])
    }

    func testItemCarriesCreationDateAndLowercasedExtension() {
        let asset = BackupFixtures.asset("a", created: 1_700_000_000, [(.photo, "IMG_0001.HEIC")])
        let item = BackupResourceSelector.items(for: asset)[0]
        XCTAssertEqual(item.capturedAt, Date(timeIntervalSince1970: 1_700_000_000))
        XCTAssertEqual(item.fileExtension, ".heic")
        XCTAssertEqual(item.key, BackupItemKey(assetId: "a", resource: .photo))
        let noExtension = BackupItem(assetId: "a", resource: .photo, sourceKind: .photo, filename: "IMG", capturedAt: nil)
        XCTAssertEqual(noExtension.fileExtension, "")
    }
}

final class BackupPlannerTests: XCTestCase {
    private func plan(
        _ assets: [BackupAsset],
        includeVideos: Bool = true,
        extensions: Set<String> = BackupFixtures.extensions,
        ledger: BackupLedger.Snapshot = BackupLedger.Snapshot(),
        inFlight: Set<BackupItemKey> = []
    ) -> BackupPlan {
        BackupPlanner.plan(
            assets: assets,
            includeVideos: includeVideos,
            extensions: extensions,
            ledger: ledger,
            inFlight: inFlight
        )
    }

    func testPendingIsNewestFirstWithUndatedLast() {
        let result = plan([
            BackupFixtures.asset("old", created: 100, [(.photo, "A.HEIC")]),
            BackupFixtures.asset("undated", created: nil, [(.photo, "B.HEIC")]),
            BackupFixtures.asset("new", created: 300, [(.photo, "C.HEIC")]),
            BackupFixtures.asset("mid", created: 200, [(.photo, "D.HEIC")]),
        ])
        XCTAssertEqual(result.pending.map(\.assetId), ["new", "mid", "old", "undated"])
        XCTAssertEqual(result.totalAssets, 4)
        XCTAssertEqual(result.backedUpAssets, 0)
    }

    func testVideoToggleDropsVideoAssetsButKeepsLivePhotoClips() {
        let assets = [
            BackupFixtures.asset("video", created: 3, video: true, [(.video, "V.MOV")]),
            BackupFixtures.asset("live", created: 2, [(.photo, "L.HEIC"), (.pairedVideo, "L.MOV")]),
        ]
        let without = plan(assets, includeVideos: false)
        XCTAssertEqual(without.pending.map(\.key), [
            BackupItemKey(assetId: "live", resource: .photo),
            BackupItemKey(assetId: "live", resource: .pairedVideo),
        ])
        XCTAssertEqual(without.totalAssets, 1)

        let with = plan(assets, includeVideos: true)
        XCTAssertEqual(with.pending.map(\.assetId), ["video", "live", "live"])
        XCTAssertEqual(with.totalAssets, 2)
    }

    func testUnsupportedExtensionsAreNeverPending() {
        let result = plan(
            [
                BackupFixtures.asset("raw", created: 2, [(.photo, "R.JPG"), (.alternatePhoto, "R.CR3")]),
                BackupFixtures.asset("gif", created: 1, [(.photo, "G.GIF")]),
            ],
            extensions: [".jpg"]
        )
        XCTAssertEqual(result.pending.map(\.key), [BackupItemKey(assetId: "raw", resource: .photo)])
        XCTAssertEqual(result.unsupportedFiles, 2)
        XCTAssertEqual(result.totalAssets, 1, "an asset with no supported original is not counted")
    }

    func testDiffAgainstLedgerAndInFlight() {
        var snapshot = BackupLedger.Snapshot()
        snapshot.records[BackupItemKey(assetId: "done", resource: .photo)] = .init(status: .uploaded, detail: "Uploads/x")
        snapshot.records[BackupItemKey(assetId: "half", resource: .photo)] = .init(status: .uploaded, detail: nil)
        snapshot.records[BackupItemKey(assetId: "skipped", resource: .photo)] = .init(status: .skipped, detail: "Too large")
        let result = plan(
            [
                BackupFixtures.asset("done", created: 5, [(.photo, "A.HEIC")]),
                BackupFixtures.asset("half", created: 4, [(.photo, "B.HEIC"), (.pairedVideo, "B.MOV")]),
                BackupFixtures.asset("skipped", created: 3, [(.photo, "C.HEIC")]),
                BackupFixtures.asset("flying", created: 2, [(.photo, "D.HEIC")]),
                BackupFixtures.asset("new", created: 1, [(.photo, "E.HEIC")]),
            ],
            ledger: snapshot,
            inFlight: [BackupItemKey(assetId: "flying", resource: .photo)]
        )
        XCTAssertEqual(result.pending.map(\.key), [
            BackupItemKey(assetId: "half", resource: .pairedVideo),
            BackupItemKey(assetId: "new", resource: .photo),
        ])
        XCTAssertEqual(result.totalAssets, 5)
        XCTAssertEqual(result.backedUpAssets, 1)
        XCTAssertEqual(result.skippedFiles, 1)
        XCTAssertEqual(result.remainingByAsset, ["half": 1, "skipped": 1, "flying": 1, "new": 1])
    }
}

final class BackupUploadRequestTests: XCTestCase {
    private let base = URL(string: "https://photos.example.test")!

    private func item(capturedAt: Date?) -> BackupItem {
        BackupItem(
            assetId: "ABC-123/L0/001",
            resource: .pairedVideo,
            sourceKind: .pairedVideo,
            filename: "IMG 0001+1.MOV",
            capturedAt: capturedAt
        )
    }

    func testURLEncodesEveryParameterIncludingPlus() throws {
        let url = try XCTUnwrap(UploadRequestBuilder.url(
            baseURL: base,
            deviceId: "6f1c2a8e-3a5b-4c55-9b1e-1f3a3c2d4e5f",
            deviceName: "Eric's iPhone+",
            item: item(capturedAt: Date(timeIntervalSince1970: 1_791_120_309)), // 2026-10-04T13:25:09Z
            capturedAt: BackupCapturedAtFormatter(timeZone: TimeZone(secondsFromGMT: 2 * 3600)!)
        ))
        XCTAssertEqual(url.path, "/api/v1/uploads")
        let expected = [
            "deviceId=6f1c2a8e-3a5b-4c55-9b1e-1f3a3c2d4e5f",
            "deviceName=Eric%27s%20iPhone%2B",
            "filename=IMG%200001%2B1.MOV",
            "assetId=ABC-123%2FL0%2F001",
            "resource=pairedVideo",
            "capturedAt=2026-10-04T15%3A25%3A09%2B02%3A00",
        ].joined(separator: "&")
        XCTAssertEqual(url.query(percentEncoded: true), expected)
        let components = try XCTUnwrap(URLComponents(url: url, resolvingAgainstBaseURL: false))
        let values = Dictionary(uniqueKeysWithValues: (components.queryItems ?? []).map { ($0.name, $0.value ?? "") })
        XCTAssertEqual(values["deviceName"], "Eric's iPhone+")
        XCTAssertEqual(values["capturedAt"], "2026-10-04T15:25:09+02:00")
    }

    func testCapturedAtIsOmittedWithoutCreationDate() throws {
        let url = try XCTUnwrap(UploadRequestBuilder.url(
            baseURL: base,
            deviceId: "6f1c2a8e-3a5b-4c55-9b1e-1f3a3c2d4e5f",
            deviceName: "iPhone",
            item: item(capturedAt: nil),
            capturedAt: BackupCapturedAtFormatter(timeZone: .gmt)
        ))
        XCTAssertFalse(try XCTUnwrap(url.query).contains("capturedAt"))
    }

    func testCapturedAtFormatsWithTheZoneOffset() {
        let date = Date(timeIntervalSince1970: 1_767_225_600) // 2026-01-01T00:00:00Z
        XCTAssertEqual(BackupCapturedAtFormatter(timeZone: .gmt).string(from: date), "2026-01-01T00:00:00Z")
        XCTAssertEqual(
            BackupCapturedAtFormatter(timeZone: TimeZone(secondsFromGMT: -5 * 3600)!).string(from: date),
            "2025-12-31T19:00:00-05:00"
        )
        XCTAssertEqual(
            BackupCapturedAtFormatter(timeZone: TimeZone(secondsFromGMT: 5 * 3600 + 1800)!).string(from: date),
            "2026-01-01T05:30:00+05:30"
        )
    }

    func testRequestIsAnOctetStreamPostHonouringCellular() throws {
        let url = try XCTUnwrap(URL(string: "https://photos.example.test/api/v1/uploads?x=1"))
        let blocked = UploadRequestBuilder.request(url: url, allowsCellularAccess: false)
        XCTAssertEqual(blocked.httpMethod, "POST")
        XCTAssertEqual(blocked.value(forHTTPHeaderField: "Content-Type"), "application/octet-stream")
        XCTAssertFalse(blocked.allowsCellularAccess)
        XCTAssertTrue(UploadRequestBuilder.request(url: url, allowsCellularAccess: true).allowsCellularAccess)
    }

    func testNonHTTPBaseIsRejected() {
        XCTAssertNil(UploadRequestBuilder.url(
            baseURL: URL(string: "file:///tmp")!,
            deviceId: "6f1c2a8e-3a5b-4c55-9b1e-1f3a3c2d4e5f",
            deviceName: "iPhone",
            item: item(capturedAt: nil),
            capturedAt: BackupCapturedAtFormatter(timeZone: .gmt)
        ))
    }
}

final class UploadResponseClassifierTests: XCTestCase {
    private func classify(_ status: Int?, _ body: Data = Data(), error: Error? = nil) -> UploadOutcome {
        UploadResponseClassifier.classify(status: status, body: body, error: error)
    }

    func testCreatedAndDuplicateAreDone() {
        XCTAssertEqual(
            classify(201, BackupFixtures.created("Uploads/iPhone/2026/10/IMG_0001.HEIC")),
            .done(path: "Uploads/iPhone/2026/10/IMG_0001.HEIC", duplicate: false)
        )
        XCTAssertEqual(
            classify(200, BackupFixtures.duplicate("2019/IMG_0001.HEIC")),
            .done(path: "2019/IMG_0001.HEIC", duplicate: true)
        )
    }

    func testMismatchedOrMalformedSuccessIsRetried() {
        guard case .retry = classify(201, BackupFixtures.duplicate("x")) else { return XCTFail("expected retry") }
        guard case .retry = classify(200, Data("{}".utf8)) else { return XCTFail("expected retry") }
    }

    func testPermanentRejectionsAreSkipped() {
        XCTAssertEqual(
            classify(413, BackupFixtures.error("UPLOAD_TOO_LARGE")),
            .skipped(reason: "Larger than the server's upload limit")
        )
        XCTAssertEqual(
            classify(415, BackupFixtures.error("UNSUPPORTED_MEDIA")),
            .skipped(reason: "File type not supported by the server")
        )
        XCTAssertEqual(
            classify(400, BackupFixtures.error("INVALID_REQUEST", "Invalid filename")),
            .skipped(reason: "Rejected by the server: Invalid filename")
        )
    }

    func testUploadsDisabledStops() {
        XCTAssertEqual(classify(503, BackupFixtures.error("UPLOADS_DISABLED")), .disabled)
        guard case .retry = classify(503, Data("busy".utf8)) else { return XCTFail("other 503s retry") }
    }

    func testStorageServerAndNetworkFailuresRetry() {
        XCTAssertEqual(
            classify(507, BackupFixtures.error("INSUFFICIENT_STORAGE")),
            .retry(message: "The server is out of storage space.")
        )
        guard case .retry = classify(500, BackupFixtures.error("INTERNAL_ERROR")) else { return XCTFail("500 retries") }
        guard case .retry = classify(400, BackupFixtures.error("UPLOAD_INCOMPLETE")) else {
            return XCTFail("an incomplete body retries")
        }
        guard case .retry = classify(nil, error: URLError(.notConnectedToInternet)) else {
            return XCTFail("network errors retry")
        }
        guard case .retry = classify(nil) else { return XCTFail("a missing response retries") }
    }

    func testLocalCancellationKeepsItemPending() {
        XCTAssertEqual(classify(nil, error: URLError(.cancelled)), .cancelled)
    }
}

final class BackupLedgerTests: XCTestCase {
    private var directory: URL!
    private let device = "6f1c2a8e-3a5b-4c55-9b1e-1f3a3c2d4e5f"

    override func setUp() {
        super.setUp()
        directory = BackupFixtures.temporaryDirectory()
    }

    override func tearDown() {
        try? FileManager.default.removeItem(at: directory)
        super.tearDown()
    }

    private var file: URL { directory.appendingPathComponent("Backup/ledger.jsonl") }

    func testStatePersistsAcrossReloads() {
        let key = BackupItemKey(assetId: "a", resource: .photo)
        let other = BackupItemKey(assetId: "b", resource: .video)
        let now = Date(timeIntervalSince1970: 1_000)
        do {
            let ledger = BackupLedger(fileURL: file, deviceId: device)
            ledger.reconcile(known: [BackupItemKey(assetId: "k", resource: .alternatePhoto)])
            ledger.record(key, .init(status: .uploaded, detail: "Uploads/iPhone/2026/10/A.HEIC"))
            ledger.recordRetry(other, message: "Offline", now: now)
            ledger.beginTransfer(.init(key: BackupItemKey(assetId: "c", resource: .photo), filename: "C.HEIC", tempName: "T1.heic"))
        }
        let reloaded = BackupLedger(fileURL: file, deviceId: device)
        let snapshot = reloaded.snapshot
        XCTAssertTrue(snapshot.reconciled)
        XCTAssertEqual(snapshot.records[key], .init(status: .uploaded, detail: "Uploads/iPhone/2026/10/A.HEIC"))
        XCTAssertEqual(snapshot.records[BackupItemKey(assetId: "k", resource: .alternatePhoto)]?.status, .uploaded)
        XCTAssertEqual(snapshot.retries[other]?.attempts, 1)
        XCTAssertEqual(snapshot.retries[other]?.notBefore, now.addingTimeInterval(30))
        XCTAssertEqual(reloaded.transfers["T1.heic"]?.filename, "C.HEIC")
    }

    func testRecordClearsRetryAndRetriesBackOff() {
        let ledger = BackupLedger(fileURL: file, deviceId: device)
        let key = BackupItemKey(assetId: "a", resource: .photo)
        let now = Date(timeIntervalSince1970: 0)
        XCTAssertEqual(ledger.recordRetry(key, message: "x", now: now).notBefore, now.addingTimeInterval(30))
        XCTAssertEqual(ledger.recordRetry(key, message: "x", now: now).notBefore, now.addingTimeInterval(60))
        XCTAssertEqual(ledger.recordRetry(key, message: "x", now: now).notBefore, now.addingTimeInterval(120))
        ledger.makeRetriesDue(now: now)
        XCTAssertEqual(ledger.retry(for: key)?.notBefore, now)
        XCTAssertEqual(ledger.retry(for: key)?.attempts, 3)
        ledger.record(key, .init(status: .uploaded, detail: nil))
        XCTAssertNil(BackupLedger(fileURL: file, deviceId: device).retry(for: key))
        XCTAssertEqual(BackupBackoff.delay(attempts: 40), BackupBackoff.maximum)
    }

    func testAnotherDeviceIdStartsEmpty() {
        BackupLedger(fileURL: file, deviceId: device).record(BackupItemKey(assetId: "a", resource: .photo), .init(status: .uploaded, detail: nil))
        let other = BackupLedger(fileURL: file, deviceId: "11111111-2222-3333-4444-555555555555")
        XCTAssertTrue(other.snapshot.records.isEmpty)
        XCTAssertFalse(other.isReconciled)
    }

    func testTornTailIsIgnoredAndCompacted() throws {
        let key = BackupItemKey(assetId: "a", resource: .photo)
        BackupLedger(fileURL: file, deviceId: device).record(key, .init(status: .uploaded, detail: "x"))
        let handle = try FileHandle(forWritingTo: file)
        try handle.seekToEnd()
        try handle.write(contentsOf: Data(#"{"record":{"_0":{"assetId":"b""#.utf8))
        try handle.close()
        let reloaded = BackupLedger(fileURL: file, deviceId: device)
        XCTAssertEqual(reloaded.record(for: key)?.detail, "x")
        reloaded.record(BackupItemKey(assetId: "c", resource: .photo), .init(status: .uploaded, detail: nil))
        XCTAssertEqual(BackupLedger(fileURL: file, deviceId: device).snapshot.records.count, 2)
    }

    func testCompletionAfterRelaunchIsRecordedAndDeletesTempFile() throws {
        let temp = directory.appendingPathComponent("Uploads", isDirectory: true)
        try FileManager.default.createDirectory(at: temp, withIntermediateDirectories: true)
        let key = BackupItemKey(assetId: "a", resource: .photo)
        let tempName = "8F1E.heic"
        try Data([1, 2, 3]).write(to: temp.appendingPathComponent(tempName))
        BackupLedger(fileURL: file, deviceId: device)
            .beginTransfer(.init(key: key, filename: "IMG_0001.HEIC", tempName: tempName))

        // Relaunch: a fresh ledger and processor receive the session's queued completion.
        let processor = BackupCompletionProcessor(ledger: BackupLedger(fileURL: file, deviceId: device), temporaryDirectory: temp)
        let result = processor.complete(
            tempName: tempName,
            status: 201,
            body: BackupFixtures.created("Uploads/iPhone/2026/10/IMG_0001.HEIC"),
            error: nil
        )
        XCTAssertEqual(result?.outcome, .done(path: "Uploads/iPhone/2026/10/IMG_0001.HEIC", duplicate: false))
        XCTAssertFalse(FileManager.default.fileExists(atPath: temp.appendingPathComponent(tempName).path))
        XCTAssertNil(processor.complete(tempName: tempName, status: 201, body: Data(), error: nil), "delivered once")

        let afterNextLaunch = BackupLedger(fileURL: file, deviceId: device)
        XCTAssertEqual(afterNextLaunch.record(for: key)?.status, .uploaded)
        XCTAssertTrue(afterNextLaunch.transfers.isEmpty)
    }

    func testProcessorRecordsSkipsRetriesAndLeavesCancelledPending() {
        let ledger = BackupLedger(fileURL: file, deviceId: device)
        let processor = BackupCompletionProcessor(ledger: ledger, temporaryDirectory: directory, now: { Date(timeIntervalSince1970: 0) })
        let keys = (0..<3).map { BackupItemKey(assetId: "a\($0)", resource: .photo) }
        for (index, key) in keys.enumerated() {
            ledger.beginTransfer(.init(key: key, filename: "F\(index).HEIC", tempName: "t\(index)"))
        }
        _ = processor.complete(tempName: "t0", status: 415, body: BackupFixtures.error("UNSUPPORTED_MEDIA"), error: nil)
        _ = processor.complete(tempName: "t1", status: 507, body: BackupFixtures.error("INSUFFICIENT_STORAGE"), error: nil)
        _ = processor.complete(tempName: "t2", status: nil, body: Data(), error: URLError(.cancelled))
        XCTAssertEqual(ledger.record(for: keys[0]), .init(status: .skipped, detail: "File type not supported by the server"))
        XCTAssertEqual(ledger.retry(for: keys[1])?.attempts, 1)
        XCTAssertNil(ledger.record(for: keys[2]))
        XCTAssertNil(ledger.retry(for: keys[2]))
        XCTAssertTrue(ledger.transfers.isEmpty)
    }
}

final class BackupSettingsTests: XCTestCase {
    func testDefaultsAndRoundTrip() throws {
        let suite = "BackupSettingsTests-\(UUID().uuidString)"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }
        let store = BackupSettingsStore(defaults: defaults)
        XCTAssertEqual(store.load(), BackupSettings(enabled: false, includeVideos: true, allowCellular: false, deviceName: "iPhone"))
        let changed = BackupSettings(enabled: true, includeVideos: false, allowCellular: true, deviceName: "Eric’s iPhone")
        store.save(changed)
        XCTAssertEqual(BackupSettingsStore(defaults: defaults).load(), changed)
    }

    func testDeviceNameNormalization() {
        XCTAssertEqual(BackupSettings.normalizedDeviceName("  Eric's iPhone \n"), "Eric's iPhone")
        XCTAssertEqual(BackupSettings.normalizedDeviceName("   "), "iPhone")
        XCTAssertEqual(BackupSettings.normalizedDeviceName(String(repeating: "x", count: 80)).count, 64)
    }

    func testDeviceIdIsGeneratedOnceAndRestoredFromEitherStore() {
        final class Box: DeviceIDStorage {
            var value: String?
            init(_ value: String? = nil) { self.value = value }
            func read() -> String? { value }
            func write(_ id: String) { value = id }
        }
        let keychain = Box()
        let defaults = Box()
        let id = BackupDeviceID.resolve(primary: keychain, fallback: defaults)
        XCTAssertNotNil(UUID(uuidString: id))
        XCTAssertEqual(keychain.value, id)
        XCTAssertEqual(defaults.value, id)
        XCTAssertEqual(BackupDeviceID.resolve(primary: keychain, fallback: defaults), id)

        // Reinstall: defaults are wiped, the Keychain copy survives.
        let reinstalled = Box()
        XCTAssertEqual(BackupDeviceID.resolve(primary: keychain, fallback: reinstalled), id)
        XCTAssertEqual(reinstalled.value, id)

        // Keychain unavailable: the defaults copy is kept.
        XCTAssertEqual(BackupDeviceID.resolve(primary: Box(), fallback: Box(id.uppercased())), id)
    }
}

final class BackupReconcilerTests: XCTestCase {
    func testKnownIsQueriedInChunksOfAThousand() async throws {
        let server = FakeBackupServer()
        await server.setKnown(["a0": [.photo, .pairedVideo], "a1500": [.alternatePhoto], "a2499": [.video]])
        var ids = (0..<2_500).map { "a\($0)" }
        ids.append("a0")
        let keys = try await BackupReconciler.knownKeys(
            api: server,
            deviceId: "6f1c2a8e-3a5b-4c55-9b1e-1f3a3c2d4e5f",
            assetIds: ids
        )
        let requests = await server.knownRequests
        XCTAssertEqual(requests.map(\.count), [1_000, 1_000, 500])
        XCTAssertEqual(requests[0].first, "a0")
        XCTAssertEqual(requests[2].last, "a2499")
        XCTAssertEqual(Set(keys), [
            BackupItemKey(assetId: "a0", resource: .photo),
            BackupItemKey(assetId: "a0", resource: .pairedVideo),
            BackupItemKey(assetId: "a1500", resource: .alternatePhoto),
            BackupItemKey(assetId: "a2499", resource: .video),
        ])
    }

    func testEmptyLibrarySendsNothing() async throws {
        let server = FakeBackupServer()
        let keys = try await BackupReconciler.knownKeys(api: server, deviceId: "x", assetIds: [])
        XCTAssertEqual(keys, [])
        let requests = await server.knownRequests
        XCTAssertTrue(requests.isEmpty)
    }

    func testAPIClientRoutesAndBodies() async throws {
        StubURLProtocol.reset()
        defer { StubURLProtocol.reset() }
        let client = StubURLProtocol.makeClient()
        StubURLProtocol.respond(status: 200, body: #"{"enabled":true,"maxBytes":100,"extensions":[".heic"]}"#)
        let config = try await client.uploadConfig()
        XCTAssertEqual(config, UploadConfigDTO(enabled: true, maxBytes: 100, extensions: [".heic"]))
        XCTAssertEqual(StubURLProtocol.requests.last?.url?.path, "/api/v1/uploads/config")

        StubURLProtocol.respond(status: 200, body: #"{"assets":[{"assetId":"a","resources":["photo","pairedVideo"]}]}"#)
        let known = try await client.knownUploads(deviceId: "6f1c2a8e-3a5b-4c55-9b1e-1f3a3c2d4e5f", assetIds: ["a", "b"])
        XCTAssertEqual(known.assets, [.init(assetId: "a", resources: [.photo, .pairedVideo])])
        let request = try XCTUnwrap(StubURLProtocol.requests.last)
        XCTAssertEqual(request.httpMethod, "POST")
        XCTAssertEqual(request.url?.path, "/api/v1/uploads/known")
        let body = try JSONDecoder().decode(KnownUploadsRequestDTO.self, from: XCTUnwrap(request.httpBody))
        XCTAssertEqual(body, KnownUploadsRequestDTO(deviceId: "6f1c2a8e-3a5b-4c55-9b1e-1f3a3c2d4e5f", assetIds: ["a", "b"]))

        StubURLProtocol.respond(status: 503, body: #"{"error":{"code":"UPLOADS_DISABLED","message":"Uploads are disabled"}}"#)
        do {
            _ = try await client.knownUploads(deviceId: "6f1c2a8e-3a5b-4c55-9b1e-1f3a3c2d4e5f", assetIds: ["a"])
            XCTFail("expected 503")
        } catch {
            XCTAssertEqual(error as? PhotoBrainAPIError, .server(status: 503, code: "UPLOADS_DISABLED", message: "Uploads are disabled"))
        }
    }
}
