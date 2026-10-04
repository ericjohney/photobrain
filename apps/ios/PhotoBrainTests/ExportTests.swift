import XCTest
@testable import PhotoBrain

final class ExportURLTests: XCTestCase {
    private let base = URL(string: "https://photos.example.test")!

    func testPhotoExportURLSendsEachSizeExplicitly() throws {
        let expected: [(ExportSize, String)] = [(.original, "original"), (.jpeg2048, "2048"), (.jpeg1024, "1024")]
        for (size, value) in expected {
            let url = ExportTarget.photo(id: 42, size: size).url(baseURL: base)
            let components = try XCTUnwrap(URLComponents(url: url, resolvingAgainstBaseURL: false))
            XCTAssertEqual(components.host, "photos.example.test")
            XCTAssertEqual(components.path, "/api/photos/42/export")
            XCTAssertEqual(components.queryItems, [URLQueryItem(name: "size", value: value)])
        }
    }

    func testCollectionExportURLSendsEachSizeExplicitly() throws {
        // The collection route defaults to `original` and the photo route to `2048`, so the
        // client never relies on either default.
        for size in ExportSize.allCases {
            let url = ExportTarget.collection(id: 7, size: size).url(baseURL: base)
            let components = try XCTUnwrap(URLComponents(url: url, resolvingAgainstBaseURL: false))
            XCTAssertEqual(components.path, "/api/collections/7/export")
            XCTAssertEqual(components.queryItems, [URLQueryItem(name: "size", value: size.rawValue)])
        }
    }

    func testExportRoutesAreOutsideTheJSONAPI() {
        let url = ExportTarget.photo(id: 1, size: .jpeg1024).url(baseURL: URL(string: "https://p.example/")!)
        XCTAssertEqual(url.absoluteString, "https://p.example/api/photos/1/export?size=1024")
    }

    func testFallbackFilenamesFollowServerNaming() {
        XCTAssertEqual(ExportTarget.photo(id: 3, size: .jpeg2048).fallbackFilename(mimeType: "image/jpeg"), "photo-3_2048.jpg")
        XCTAssertEqual(ExportTarget.photo(id: 3, size: .jpeg1024).fallbackFilename(mimeType: nil), "photo-3_1024.jpg")
        XCTAssertEqual(ExportTarget.photo(id: 3, size: .original).fallbackFilename(mimeType: "image/heic"), "photo-3.heic")
        XCTAssertEqual(ExportTarget.photo(id: 3, size: .original).fallbackFilename(mimeType: "image/png"), "photo-3.png")
        XCTAssertEqual(ExportTarget.photo(id: 3, size: .original).fallbackFilename(mimeType: nil), "photo-3")
        XCTAssertEqual(ExportTarget.collection(id: 9, size: .jpeg2048).fallbackFilename(mimeType: "application/zip"), "collection-9.zip")
    }
}

final class ContentDispositionTests: XCTestCase {
    func testExtendedUTF8FilenameIsPreferredRegardlessOfOrder() {
        XCTAssertEqual(
            ContentDisposition.filename(from: #"attachment; filename="caf_.jpg"; filename*=UTF-8''caf%C3%A9.jpg"#),
            "café.jpg"
        )
        XCTAssertEqual(
            ContentDisposition.filename(from: #"attachment; filename*=UTF-8''%E6%97%85%E8%A1%8C.zip; filename="__.zip""#),
            "旅行.zip"
        )
    }

    func testExtendedValueAcceptsLanguageTagCaseAndLatin1() {
        XCTAssertEqual(ContentDisposition.filename(from: "attachment; FILENAME*=utf-8'en'a%20b.jpg"), "a b.jpg")
        XCTAssertEqual(ContentDisposition.filename(from: "attachment; filename*=iso-8859-1''%E9t%E9.jpg"), "été.jpg")
    }

    func testMalformedExtendedValueFallsBackToQuotedFilename() {
        for header in [
            #"attachment; filename*=UTF-8''bad%G1.jpg; filename="good.jpg""#,
            #"attachment; filename*=UTF-8''trunc%C; filename="good.jpg""#,
            #"attachment; filename*=UTF-8''%FF%FE.jpg; filename="good.jpg""#,
            #"attachment; filename*=KOI8-R''x.jpg; filename="good.jpg""#,
            #"attachment; filename*=no-quotes.jpg; filename="good.jpg""#,
        ] {
            XCTAssertEqual(ContentDisposition.filename(from: header), "good.jpg", header)
        }
    }

    func testQuotedFilenameUnescapesAndKeepsSemicolons() {
        XCTAssertEqual(ContentDisposition.filename(from: #"attachment; filename="a \"b\".jpg""#), #"a "b".jpg"#)
        XCTAssertEqual(ContentDisposition.filename(from: #"attachment; filename="x; y.jpg""#), "x; y.jpg")
        XCTAssertEqual(ContentDisposition.filename(from: "attachment; filename=plain.jpg"), "plain.jpg")
    }

    func testMissingHeaderOrFilenameIsNil() {
        XCTAssertNil(ContentDisposition.filename(from: nil))
        XCTAssertNil(ContentDisposition.filename(from: "attachment"))
        XCTAssertNil(ContentDisposition.filename(from: #"attachment; filename="""#))
        XCTAssertNil(ContentDisposition.filename(from: "inline; name=photo.jpg"))
    }

    func testPathTraversalKeepsOnlyTheLastComponent() {
        XCTAssertEqual(ExportFilename.sanitized("../x"), "x")
        XCTAssertEqual(ExportFilename.sanitized("../../etc/passwd"), "passwd")
        XCTAssertEqual(ExportFilename.sanitized(#"..\..\x.zip"#), "x.zip")
        XCTAssertEqual(ExportFilename.sanitized("/var/mobile/x.jpg"), "x.jpg")
        XCTAssertNil(ExportFilename.sanitized(".."))
        XCTAssertNil(ExportFilename.sanitized("../"))
        XCTAssertNil(ExportFilename.sanitized("/"))
        XCTAssertNil(ExportFilename.sanitized("  "))
    }

    func testTraversalSurvivingDecodingIsSanitized() {
        let decoded = ContentDisposition.filename(from: "attachment; filename*=UTF-8''..%2F..%2Fsecret.jpg")
        XCTAssertEqual(decoded, "../../secret.jpg")
        XCTAssertEqual(decoded.flatMap(ExportFilename.sanitized), "secret.jpg")
    }

    func testUnsafeCharactersAreReplacedAndLeadingDotsStripped() {
        XCTAssertEqual(ExportFilename.sanitized(".hidden.jpg"), "hidden.jpg")
        XCTAssertEqual(ExportFilename.sanitized("a\u{0}b\u{7}c.jpg"), "a_b_c.jpg")
        XCTAssertEqual(ExportFilename.sanitized("12:30.jpg"), "12_30.jpg")
        XCTAssertEqual(ExportFilename.sanitized("evil\u{202E}gpj.exe"), "evil_gpj.exe")
        XCTAssertEqual(ExportFilename.sanitized("  Trip 2024 (2).zip "), "Trip 2024 (2).zip")
        XCTAssertEqual(ExportFilename.sanitized("Café ☕️.jpg"), "Café ☕️.jpg")
    }

    func testOverlongNamesAreTruncatedToAPFSLimitKeepingExtension() throws {
        let ascii = try XCTUnwrap(ExportFilename.sanitized(String(repeating: "a", count: 300) + ".jpg"))
        XCTAssertEqual(ascii.utf8.count, ExportFilename.maximumBytes)
        XCTAssertTrue(ascii.hasSuffix("a.jpg"))

        let multibyte = try XCTUnwrap(ExportFilename.sanitized(String(repeating: "é", count: 200) + ".zip"))
        XCTAssertLessThanOrEqual(multibyte.utf8.count, ExportFilename.maximumBytes)
        XCTAssertTrue(multibyte.hasSuffix("é.zip"))

        let exact = String(repeating: "b", count: 251) + ".jpg"
        XCTAssertEqual(ExportFilename.sanitized(exact), exact)
    }
}

final class ExportErrorMappingTests: XCTestCase {
    private var exportsDirectory: URL!

    override func setUp() {
        super.setUp()
        exportsDirectory = FileManager.default.temporaryDirectory
            .appendingPathComponent("ExportErrorMappingTests-\(UUID().uuidString)", isDirectory: true)
    }

    override func tearDown() {
        ExportStubURLProtocol.reset()
        try? FileManager.default.removeItem(at: exportsDirectory)
        super.tearDown()
    }

    func testPhotoNotFoundKeepsServerEnvelope() async {
        let error = await failure(.photo(id: 5, size: .jpeg2048), status: 404, code: "PHOTO_NOT_FOUND", message: "Photo not found")
        XCTAssertEqual(error, .server(status: 404, code: "PHOTO_NOT_FOUND", message: "Photo not found"))
        XCTAssertEqual(error?.errorDescription, "Photo not found")
        XCTAssertEqual(error?.isRetryable, false)
    }

    func testSourceMissingMapsToReadableMessage() async {
        let error = await failure(.photo(id: 5, size: .original), status: 404, code: "SOURCE_MISSING", message: "Source file missing")
        XCTAssertEqual(error, .server(status: 404, code: "SOURCE_MISSING", message: "Source file missing"))
        XCTAssertEqual(error?.errorDescription, "The original file is no longer in the photo library on the server.")
        XCTAssertEqual(error?.isRetryable, false)
    }

    func testCollectionNotFoundMapsToExistingCollectionMessage() async {
        let error = await failure(.collection(id: 9, size: .original), status: 404, code: "COLLECTION_NOT_FOUND", message: "Collection not found")
        XCTAssertEqual(error?.code, "COLLECTION_NOT_FOUND")
        XCTAssertEqual(error?.errorDescription, "This collection no longer exists.")
    }

    func testExportFailedUnprocessableMapsToReadableMessage() async {
        let error = await failure(.photo(id: 5, size: .jpeg1024), status: 422, code: "EXPORT_FAILED", message: "Decode failed")
        XCTAssertEqual(error, .server(status: 422, code: "EXPORT_FAILED", message: "Decode failed"))
        XCTAssertEqual(error?.errorDescription, "This photo couldn’t be converted for sharing.")
    }

    func testUnprocessableWithoutEnvelopeFallsBackToHTTPStatus() async {
        ExportStubURLProtocol.respond(status: 422, headers: ["Content-Type": "text/plain"], body: Data("nope".utf8))
        let error = await downloadError(.photo(id: 5, size: .jpeg2048))
        XCTAssertEqual(error?.code, "HTTP_422")
        XCTAssertNoExportFiles()
    }

    func testInvalidRequestEnvelopeStaysAServerError() async {
        let error = await failure(.photo(id: 5, size: .jpeg2048), status: 400, code: "INVALID_REQUEST", message: "Invalid size")
        XCTAssertEqual(error, .server(status: 400, code: "INVALID_REQUEST", message: "Invalid size"))
    }

    func testExportBusyCarriesRetryAfterAndIsRetryable() async {
        ExportStubURLProtocol.respond(
            status: 503,
            headers: ["Content-Type": "application/json", "Retry-After": "30"],
            body: Data(#"{"error":{"code":"EXPORT_BUSY","message":"Render queue full"}}"#.utf8)
        )
        let error = await downloadError(.photo(id: 5, size: .jpeg2048))
        XCTAssertEqual(error, .exportBusy(retryAfter: 30))
        XCTAssertEqual(error?.code, "EXPORT_BUSY")
        XCTAssertEqual(error?.isRetryable, true)
        XCTAssertEqual(error?.errorDescription, "The server is busy preparing other exports. Try again in 30 seconds.")
        XCTAssertNoExportFiles()
    }

    func testExportBusyWithoutRetryAfterStillMapsToBusy() async {
        ExportStubURLProtocol.respond(
            status: 503,
            headers: ["Content-Type": "application/json"],
            body: Data(#"{"error":{"code":"EXPORT_BUSY","message":"Render queue full"}}"#.utf8)
        )
        let error = await downloadError(.photo(id: 5, size: .original))
        XCTAssertEqual(error, .exportBusy(retryAfter: nil))
        XCTAssertEqual(error?.errorDescription, "The server is busy preparing other exports. Try again in a moment.")
    }

    func testOtherServiceUnavailableIsNotBusy() async {
        let error = await failure(.photo(id: 5, size: .jpeg2048), status: 503, code: "MAINTENANCE", message: "Down")
        XCTAssertEqual(error, .server(status: 503, code: "MAINTENANCE", message: "Down"))
        XCTAssertEqual(error?.isRetryable, false)
    }

    func testRetryAfterParsesSecondsAndHTTPDates() {
        let now = Date(timeIntervalSince1970: 1_790_000_000)
        XCTAssertEqual(RetryAfter.seconds(from: "120", now: now), 120)
        XCTAssertEqual(RetryAfter.seconds(from: " 5 ", now: now), 5)
        XCTAssertEqual(RetryAfter.seconds(from: "0", now: now), 0)
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.timeZone = TimeZone(identifier: "GMT")
        formatter.dateFormat = "EEE, dd MMM yyyy HH:mm:ss 'GMT'"
        XCTAssertEqual(RetryAfter.seconds(from: formatter.string(from: now.addingTimeInterval(90)), now: now), 90)
        XCTAssertEqual(RetryAfter.seconds(from: formatter.string(from: now.addingTimeInterval(-60)), now: now), 0)
        XCTAssertNil(RetryAfter.seconds(from: nil, now: now))
        XCTAssertNil(RetryAfter.seconds(from: "-1", now: now))
        XCTAssertNil(RetryAfter.seconds(from: "soon", now: now))
    }

    func testNonPositiveIDIsRejectedWithoutNetwork() async {
        for target in [ExportTarget.photo(id: 0, size: .original), .collection(id: -1, size: .original)] {
            let error = await downloadError(target)
            XCTAssertEqual(error, .invalidRequest)
        }
        XCTAssertTrue(ExportStubURLProtocol.requests.isEmpty)
    }

    private func failure(_ target: ExportTarget, status: Int, code: String, message: String) async -> PhotoBrainAPIError? {
        ExportStubURLProtocol.respond(
            status: status,
            headers: ["Content-Type": "application/json"],
            body: Data(#"{"error":{"code":"\#(code)","message":"\#(message)"}}"#.utf8)
        )
        let error = await downloadError(target)
        XCTAssertNoExportFiles()
        return error
    }

    private func downloadError(_ target: ExportTarget) async -> PhotoBrainAPIError? {
        do {
            _ = try await ExportStubURLProtocol.makeClient(exportsDirectory: exportsDirectory).download(target) { _ in }
            XCTFail("Expected an error")
            return nil
        } catch {
            guard let error = error as? PhotoBrainAPIError else {
                XCTFail("Unexpected error \(error)")
                return nil
            }
            return error
        }
    }

    private func XCTAssertNoExportFiles(file: StaticString = #filePath, line: UInt = #line) {
        XCTAssertEqual(filesOnDisk(under: exportsDirectory), [], file: file, line: line)
    }
}

final class ExportDownloadTests: XCTestCase {
    private var exportsDirectory: URL!

    override func setUp() {
        super.setUp()
        exportsDirectory = FileManager.default.temporaryDirectory
            .appendingPathComponent("ExportDownloadTests-\(UUID().uuidString)", isDirectory: true)
    }

    override func tearDown() {
        ExportStubURLProtocol.reset()
        try? FileManager.default.removeItem(at: exportsDirectory)
        super.tearDown()
    }

    func testDownloadNamesFileFromUTF8DispositionInItsOwnDirectory() async throws {
        let body = Data((0..<5_000).map { UInt8($0 % 251) })
        ExportStubURLProtocol.respond(
            status: 200,
            headers: [
                "Content-Type": "image/jpeg",
                "Content-Length": String(body.count),
                "Content-Disposition": #"attachment; filename="caf__2048.jpg"; filename*=UTF-8''caf%C3%A9_2048.jpg"#,
            ],
            body: body
        )
        let progress = ProgressLog()
        let file = try await client().download(.photo(id: 42, size: .jpeg2048)) { progress.append($0) }

        XCTAssertEqual(file.url.lastPathComponent, "café_2048.jpg")
        XCTAssertEqual(file.directory.deletingLastPathComponent().standardizedFileURL, exportsDirectory.standardizedFileURL)
        XCTAssertEqual(try Data(contentsOf: file.url), body)
        XCTAssertEqual(progress.values.last, ExportProgress(received: Int64(body.count), expected: Int64(body.count)))
        let request = try XCTUnwrap(ExportStubURLProtocol.requests.first)
        XCTAssertEqual(request.httpMethod, "GET")
        XCTAssertEqual(request.url?.path, "/api/photos/42/export")
        XCTAssertEqual(request.url?.query, "size=2048")

        file.remove()
        XCTAssertFalse(FileManager.default.fileExists(atPath: file.directory.path))
    }

    func testTraversalFilenameStaysInsideExportDirectory() async throws {
        ExportStubURLProtocol.respond(
            status: 200,
            headers: ["Content-Type": "application/zip", "Content-Disposition": #"attachment; filename="../../Trips.zip""#],
            body: Data("PK".utf8)
        )
        let file = try await client().download(.collection(id: 3, size: .original)) { _ in }
        XCTAssertEqual(file.url.lastPathComponent, "Trips.zip")
        XCTAssertEqual(filesOnDisk(under: exportsDirectory), [file.url.resolvingSymlinksInPath()])
    }

    func testMissingDispositionUsesFallbackName() async throws {
        ExportStubURLProtocol.respond(status: 200, headers: ["Content-Type": "image/heic"], body: Data("heic".utf8))
        let file = try await client().download(.photo(id: 8, size: .original)) { _ in }
        XCTAssertEqual(file.url.lastPathComponent, "photo-8.heic")
    }

    func testUnusableDispositionUsesFallbackName() async throws {
        ExportStubURLProtocol.respond(
            status: 200,
            headers: ["Content-Type": "application/zip", "Content-Disposition": #"attachment; filename="..""#],
            body: Data("PK".utf8)
        )
        let file = try await client().download(.collection(id: 4, size: .jpeg2048)) { _ in }
        XCTAssertEqual(file.url.lastPathComponent, "collection-4.zip")
    }

    func testEachDownloadGetsSeparateDirectory() async throws {
        ExportStubURLProtocol.respond(
            status: 200,
            headers: ["Content-Disposition": #"attachment; filename="same.jpg""#],
            body: Data("x".utf8)
        )
        let first = try await client().download(.photo(id: 1, size: .jpeg2048)) { _ in }
        let second = try await client().download(.photo(id: 1, size: .jpeg2048)) { _ in }
        XCTAssertNotEqual(first.directory, second.directory)
        first.remove()
        XCTAssertTrue(FileManager.default.fileExists(atPath: second.url.path))
    }

    func testTaskCancellationStopsDownloadAndLeavesNoFiles() async throws {
        ExportStubURLProtocol.respond(
            status: 200,
            headers: ["Content-Type": "application/zip", "Content-Disposition": #"attachment; filename="big.zip""#],
            body: Data(repeating: 7, count: 64 * 1_024),
            hangs: true
        )
        let client = client()
        let task = Task { try await client.download(.collection(id: 2, size: .original)) { _ in } }
        let deadline = ContinuousClock.now + .seconds(3)
        while !ExportStubURLProtocol.isLoading {
            guard ContinuousClock.now < deadline else { return XCTFail("Download never started") }
            try await Task.sleep(for: .milliseconds(10))
        }
        task.cancel()

        do {
            _ = try await task.value
            XCTFail("Expected cancellation")
        } catch {
            XCTAssertTrue(error is CancellationError, "\(error)")
        }
        XCTAssertTrue(ExportStubURLProtocol.wasStopped)
        XCTAssertEqual(filesOnDisk(under: exportsDirectory), [])
    }

    func testCancellationBeforeStartNeverLeavesFiles() async {
        ExportStubURLProtocol.respond(status: 200, headers: [:], body: Data("x".utf8))
        let client = client()
        let task = Task {
            withUnsafeCurrentTask { $0?.cancel() }
            return try await client.download(.photo(id: 1, size: .original)) { _ in }
        }
        do {
            _ = try await task.value
            XCTFail("Expected cancellation")
        } catch {
            XCTAssertTrue(error is CancellationError, "\(error)")
        }
        XCTAssertEqual(filesOnDisk(under: exportsDirectory), [])
    }

    private func client() -> APIClient {
        ExportStubURLProtocol.makeClient(exportsDirectory: exportsDirectory)
    }
}

@MainActor
final class ExportStoreTests: XCTestCase {
    func testSuccessfulExportMovesThroughDownloadingToReadyAndCleansUp() async throws {
        let api = TestAPI()
        await api.setExport(.file(name: "IMG_1_2048.jpg", bytes: Data("jpeg".utf8)), delay: .milliseconds(200))
        let store = ExportStore(api: api)
        XCTAssertEqual(store.state, .idle)

        store.start(.photo(id: 1, size: .jpeg2048))
        XCTAssertEqual(store.state, .downloading(.photo(id: 1, size: .jpeg2048), progress: nil))
        XCTAssertTrue(store.isBusy)
        try await waitUntil {
            store.state == .downloading(.photo(id: 1, size: .jpeg2048), progress: ExportProgress(received: 4, expected: 8))
        }
        try await waitUntil { store.readyFile != nil }

        let file = try XCTUnwrap(store.readyFile)
        XCTAssertEqual(file.url.lastPathComponent, "IMG_1_2048.jpg")
        XCTAssertEqual(try Data(contentsOf: file.url), Data("jpeg".utf8))
        XCTAssertEqual(api.exportFilesOnDisk(), [file.url.resolvingSymlinksInPath()])

        store.finishSharing()
        XCTAssertEqual(store.state, .idle)
        XCTAssertFalse(store.isBusy)
        XCTAssertEqual(api.exportFilesOnDisk(), [])
        let requests = await api.recordedExportRequests()
        XCTAssertEqual(requests, [.photo(id: 1, size: .jpeg2048)])
    }

    func testCancelReturnsToIdleAndDeletesPartialFile() async throws {
        let api = TestAPI()
        await api.setExport(.file(name: "Trip.zip", bytes: Data("PK".utf8)), delay: .seconds(5))
        let store = ExportStore(api: api)

        store.start(.collection(id: 3, size: .original))
        try await waitUntil { api.exportFilesOnDisk().map(\.lastPathComponent) == ["partial.download"] }
        store.cancel()

        XCTAssertEqual(store.state, .idle)
        try await waitUntil { api.exportFilesOnDisk().isEmpty }
        try await Task.sleep(for: .milliseconds(50))
        XCTAssertEqual(store.state, .idle)
    }

    func testFailureSurfacesMessageAndLeavesNoFile() async throws {
        let api = TestAPI()
        await api.setExport(.failure(.server(status: 404, code: "SOURCE_MISSING", message: "Source file missing")))
        let store = ExportStore(api: api)

        store.start(.photo(id: 4, size: .original))
        try await waitUntil { if case .failed = store.state { true } else { false } }

        XCTAssertEqual(
            store.state,
            .failed(.init(message: "The original file is no longer in the photo library on the server.", retryTarget: nil))
        )
        XCTAssertFalse(store.isBusy)
        XCTAssertEqual(api.exportFilesOnDisk(), [])
        store.retry()
        XCTAssertEqual(store.state, .failed(.init(message: "The original file is no longer in the photo library on the server.", retryTarget: nil)))

        store.dismissError()
        XCTAssertEqual(store.state, .idle)
    }

    func testBusyServerOffersManualRetryOfSameExport() async throws {
        let api = TestAPI()
        await api.setExport(.failure(.exportBusy(retryAfter: 5)))
        let store = ExportStore(api: api)

        store.start(.photo(id: 6, size: .jpeg2048))
        try await waitUntil { if case .failed = store.state { true } else { false } }
        XCTAssertEqual(
            store.state,
            .failed(.init(
                message: "The server is busy preparing other exports. Try again in 5 seconds.",
                retryTarget: .photo(id: 6, size: .jpeg2048)
            ))
        )
        try await Task.sleep(for: .milliseconds(50))
        let afterFailure = await api.recordedExportRequests()
        XCTAssertEqual(afterFailure.count, 1, "Busy responses are never retried automatically")

        await api.setExport(.file(name: "IMG_6_2048.jpg", bytes: Data("ok".utf8)))
        store.retry()
        try await waitUntil { store.readyFile != nil }
        let requests = await api.recordedExportRequests()
        XCTAssertEqual(requests, [.photo(id: 6, size: .jpeg2048), .photo(id: 6, size: .jpeg2048)])
        store.finishSharing()
        XCTAssertEqual(api.exportFilesOnDisk(), [])
    }

    func testStartWhileDownloadingOrReadyIsIgnored() async throws {
        let api = TestAPI()
        await api.setExport(.file(name: "a.jpg", bytes: Data("a".utf8)), delay: .milliseconds(100))
        let store = ExportStore(api: api)

        store.start(.photo(id: 1, size: .jpeg2048))
        store.start(.photo(id: 2, size: .original))
        try await waitUntil { store.readyFile != nil }
        store.start(.photo(id: 3, size: .original))

        let requests = await api.recordedExportRequests()
        XCTAssertEqual(requests, [.photo(id: 1, size: .jpeg2048)])
        XCTAssertEqual(store.readyFile?.url.lastPathComponent, "a.jpg")
        store.finishSharing()
    }

    func testCancelledDownloadThatStillCompletesIsDeleted() async throws {
        let api = SlowCompletingAPI()
        let store = ExportStore(api: api)

        store.start(.photo(id: 1, size: .original))
        try await waitUntil { api.started }
        store.cancel()
        XCTAssertEqual(store.state, .idle)

        try await waitUntil { api.returnedFile != nil }
        let file = try XCTUnwrap(api.returnedFile)
        try await waitUntil { !FileManager.default.fileExists(atPath: file.directory.path) }
        XCTAssertEqual(store.state, .idle)
    }

    func testReleasingStoreDeletesUnsharedFile() async throws {
        let api = TestAPI()
        var store: ExportStore? = ExportStore(api: api)
        store?.start(.photo(id: 1, size: .jpeg2048))
        try await waitUntil { store?.readyFile != nil }
        XCTAssertEqual(api.exportFilesOnDisk().count, 1)

        store = nil
        XCTAssertEqual(api.exportFilesOnDisk(), [])
    }
}

/// Ignores cancellation and returns a real file afterwards, like a download whose completion
/// races a cancel.
private final class SlowCompletingAPI: PhotoBrainAPI, @unchecked Sendable {
    let baseURL = URL(string: "https://photos.example.invalid")!
    private let lock = NSLock()
    private var _started = false
    private var _returnedFile: ExportFile?

    var started: Bool { lock.withLock { _started } }
    var returnedFile: ExportFile? { lock.withLock { _returnedFile } }

    func download(_ target: ExportTarget, onProgress: @escaping @Sendable (ExportProgress) -> Void) async throws -> ExportFile {
        lock.withLock { _started = true }
        let deadline = ContinuousClock.now + .milliseconds(150)
        while ContinuousClock.now < deadline { await Task.yield() }
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        let url = directory.appendingPathComponent("late.jpg")
        try Data("late".utf8).write(to: url)
        let file = ExportFile(url: url)
        lock.withLock { _returnedFile = file }
        return file
    }

    func folders() async throws -> FoldersResponseDTO { throw PhotoBrainAPIError.invalidRequest }
    func filterOptions(folder: String?) async throws -> FilterOptionsDTO { throw PhotoBrainAPIError.invalidRequest }
    func photos(query: PhotoQuery) async throws -> PhotosResponseDTO { throw PhotoBrainAPIError.invalidRequest }
    func locations(query: PhotoQuery) async throws -> LocationsResponseDTO { throw PhotoBrainAPIError.invalidRequest }
    func photo(id: Int) async throws -> PhotoDTO { throw PhotoBrainAPIError.invalidRequest }
    func search(query: String, limit: Int, filters: PhotoQuery) async throws -> SearchResponseDTO { throw PhotoBrainAPIError.invalidRequest }
    func similarPhotos(id: Int, limit: Int, event: Int?) async throws -> SimilarPhotosResponseDTO { throw PhotoBrainAPIError.invalidRequest }
    func photoTags(id: Int) async throws -> PhotoTagsResponseDTO { throw PhotoBrainAPIError.invalidRequest }
    func photoPlace(id: Int) async throws -> PhotoPlaceResponseDTO { throw PhotoBrainAPIError.invalidRequest }
    func onThisDay(date: Date) async throws -> OnThisDayResponseDTO { throw PhotoBrainAPIError.invalidRequest }
    func events(folder: String?) async throws -> EventsResponseDTO { throw PhotoBrainAPIError.invalidRequest }
    func gearStats(query: PhotoQuery) async throws -> GearStatsDTO { throw PhotoBrainAPIError.invalidRequest }
    func updateCuration(id: Int, rating: Int?, flag: PhotoFlag??) async throws -> PhotoDTO { throw PhotoBrainAPIError.invalidRequest }
    func collections() async throws -> CollectionsResponseDTO { throw PhotoBrainAPIError.invalidRequest }
    func createCollection(name: String, photoIds: [Int]?) async throws -> CollectionDTO { throw PhotoBrainAPIError.invalidRequest }
    func renameCollection(id: Int, name: String) async throws -> CollectionDTO { throw PhotoBrainAPIError.invalidRequest }
    func deleteCollection(id: Int) async throws { throw PhotoBrainAPIError.invalidRequest }
    func addPhotos(toCollection id: Int, photoIds: [Int]) async throws -> CollectionPhotosAddedDTO { throw PhotoBrainAPIError.invalidRequest }
    func removePhotos(fromCollection id: Int, photoIds: [Int]) async throws -> CollectionPhotosRemovedDTO { throw PhotoBrainAPIError.invalidRequest }
    func collectionsForPhoto(id: Int) async throws -> PhotoCollectionsDTO { throw PhotoBrainAPIError.invalidRequest }
    func smartAlbums() async throws -> SmartAlbumsResponseDTO { throw PhotoBrainAPIError.invalidRequest }
    func createSmartAlbum(name: String, filters: SmartAlbumFilters, query: String?) async throws -> SmartAlbumDTO { throw PhotoBrainAPIError.invalidRequest }
    func renameSmartAlbum(id: Int, name: String) async throws -> SmartAlbumDTO { throw PhotoBrainAPIError.invalidRequest }
    func deleteSmartAlbum(id: Int) async throws { throw PhotoBrainAPIError.invalidRequest }
    func people(includeHidden: Bool) async throws -> PeopleResponseDTO { throw PhotoBrainAPIError.invalidRequest }
    func person(id: Int) async throws -> PersonDTO { throw PhotoBrainAPIError.invalidRequest }
    func updatePerson(id: Int, name: String??, hidden: Bool?) async throws -> PersonDTO { throw PhotoBrainAPIError.invalidRequest }
    func mergePeople(targetId: Int, sourceIds: [Int]) async throws -> PersonDTO { throw PhotoBrainAPIError.invalidRequest }
    func photoFaces(photoId: Int) async throws -> PhotoFacesResponseDTO { throw PhotoBrainAPIError.invalidRequest }
    func assignFace(faceId: Int, to target: FaceAssignmentTarget) async throws -> PhotoFaceDTO { throw PhotoBrainAPIError.invalidRequest }
    func junkReview(reason: JunkReason?, limit: Int, cursor: Int?) async throws -> JunkReviewResponseDTO { throw PhotoBrainAPIError.invalidRequest }
    func resolveJunk(ids: [Int], action: JunkAction) async throws -> ResolveJunkResponseDTO { throw PhotoBrainAPIError.invalidRequest }
    func duplicateGroups(kind: DuplicateKind?, limit: Int, cursor: String?) async throws -> DuplicateGroupsResponseDTO { throw PhotoBrainAPIError.invalidRequest }
    func resolveDuplicateGroup(key: String, resolution: DuplicateResolution) async throws -> ResolveDuplicateGroupResponseDTO { throw PhotoBrainAPIError.invalidRequest }
    func startScan(force: Bool) async throws -> StartScanResponseDTO { throw PhotoBrainAPIError.invalidRequest }
    func scan(id: String) async throws -> ScanDTO? { throw PhotoBrainAPIError.invalidRequest }
    func activeScans() async throws -> ActiveScansResponseDTO { throw PhotoBrainAPIError.invalidRequest }
    func cancelAll() {}
}

private final class ProgressLog: @unchecked Sendable {
    private let lock = NSLock()
    private var _values: [ExportProgress] = []

    var values: [ExportProgress] { lock.withLock { _values } }

    func append(_ value: ExportProgress) {
        lock.withLock { _values.append(value) }
    }
}

/// Serves one configured binary response to an `APIClient` built with `makeClient`, optionally
/// sending only the headers and first chunk and then stalling until cancelled.
final class ExportStubURLProtocol: URLProtocol, @unchecked Sendable {
    private struct Response {
        var status = 500
        var headers: [String: String] = [:]
        var body = Data()
        var hangs = false
    }

    private static let lock = NSLock()
    nonisolated(unsafe) private static var response = Response()
    nonisolated(unsafe) private static var recorded: [URLRequest] = []
    nonisolated(unsafe) private static var loading = false
    nonisolated(unsafe) private static var stopped = false

    static func makeClient(exportsDirectory: URL) -> APIClient {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [ExportStubURLProtocol.self]
        return APIClient(
            baseURL: URL(string: "https://photos.example.test")!,
            session: URLSession(configuration: configuration),
            exportsDirectory: exportsDirectory
        )
    }

    static func respond(status: Int, headers: [String: String], body: Data, hangs: Bool = false) {
        lock.withLock { response = Response(status: status, headers: headers, body: body, hangs: hangs) }
    }

    static var requests: [URLRequest] { lock.withLock { recorded } }
    static var isLoading: Bool { lock.withLock { loading } }
    static var wasStopped: Bool { lock.withLock { stopped } }

    static func reset() {
        lock.withLock {
            response = Response()
            recorded = []
            loading = false
            stopped = false
        }
    }

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        let response = Self.lock.withLock {
            Self.recorded.append(request)
            return Self.response
        }
        let http = HTTPURLResponse(
            url: request.url!,
            statusCode: response.status,
            httpVersion: "HTTP/1.1",
            headerFields: response.headers
        )!
        client?.urlProtocol(self, didReceive: http, cacheStoragePolicy: .notAllowed)
        if response.hangs {
            client?.urlProtocol(self, didLoad: response.body.prefix(1_024))
            Self.lock.withLock { Self.loading = true }
            return
        }
        client?.urlProtocol(self, didLoad: response.body)
        client?.urlProtocolDidFinishLoading(self)
    }

    override func stopLoading() {
        Self.lock.withLock { Self.stopped = true }
    }
}

/// Regular files below `directory`, symlinks resolved, sorted by path.
private func filesOnDisk(under directory: URL) -> [URL] {
    let enumerator = FileManager.default.enumerator(at: directory, includingPropertiesForKeys: nil)
    return (enumerator?.allObjects as? [URL] ?? [])
        .filter { !$0.hasDirectoryPath }
        .map { $0.resolvingSymlinksInPath() }
        .sorted { $0.path < $1.path }
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
