import XCTest
@testable import PhotoBrain

final class SimilarPhotosAPITests: XCTestCase {
    override func tearDown() {
        StubURLProtocol.reset()
        super.tearDown()
    }

    func testIndexedResponseDecodesPhotosAndMetadata() throws {
        let data = Data(
            """
            {"photos":[\(Self.photoJSON(id: 9))],"total":1,"sourcePhotoId":4,"indexed":true}
            """.utf8
        )
        let response = try APIModelCoding.decoder().decode(SimilarPhotosResponseDTO.self, from: data)
        XCTAssertEqual(response.photos.map(\.id), [9])
        XCTAssertEqual(response.total, 1)
        XCTAssertEqual(response.sourcePhotoId, 4)
        XCTAssertTrue(response.indexed)
    }

    func testNotIndexedResponseDecodesWithEmptyPhotos() throws {
        let data = Data(#"{"photos":[],"total":0,"sourcePhotoId":4,"indexed":false}"#.utf8)
        let response = try APIModelCoding.decoder().decode(SimilarPhotosResponseDTO.self, from: data)
        XCTAssertFalse(response.indexed)
        XCTAssertTrue(response.photos.isEmpty)
        XCTAssertEqual(response.sourcePhotoId, 4)
    }

    func testResponseMissingIndexedFlagIsRejected() {
        let data = Data(#"{"photos":[],"total":0,"sourcePhotoId":4}"#.utf8)
        XCTAssertThrowsError(try APIModelCoding.decoder().decode(SimilarPhotosResponseDTO.self, from: data))
    }

    func testClientRequestsSimilarPathWithLimitQuery() async throws {
        StubURLProtocol.respond(
            status: 200,
            body: #"{"photos":[\#(Self.photoJSON(id: 12))],"total":1,"sourcePhotoId":5,"indexed":true}"#
        )
        let response = try await makeClient().similarPhotos(id: 5, limit: 30)

        let request = try XCTUnwrap(StubURLProtocol.requests.first)
        XCTAssertEqual(StubURLProtocol.requests.count, 1)
        XCTAssertEqual(request.httpMethod, "GET")
        XCTAssertEqual(request.url?.path, "/api/v1/photos/5/similar")
        let components = try XCTUnwrap(request.url.flatMap { URLComponents(url: $0, resolvingAgainstBaseURL: false) })
        XCTAssertEqual(components.queryItems, [URLQueryItem(name: "limit", value: "30")])
        XCTAssertEqual(response.photos.map(\.id), [12])
        XCTAssertEqual(response.sourcePhotoId, 5)
    }

    func testClientAcceptsLimitBoundaries() async throws {
        StubURLProtocol.respond(status: 200, body: #"{"photos":[],"total":0,"sourcePhotoId":1,"indexed":true}"#)
        let client = makeClient()
        _ = try await client.similarPhotos(id: 1, limit: 1)
        _ = try await client.similarPhotos(id: 1, limit: 100)
        XCTAssertEqual(
            StubURLProtocol.requests.compactMap { $0.url?.query },
            ["limit=1", "limit=100"]
        )
    }

    func testClientRejectsInvalidIDAndLimitWithoutNetwork() async {
        let client = makeClient()
        for (id, limit) in [(0, 30), (-3, 30), (1, 0), (1, 101)] {
            do {
                _ = try await client.similarPhotos(id: id, limit: limit)
                XCTFail("Expected invalidRequest for id \(id), limit \(limit)")
            } catch {
                XCTAssertEqual(error as? PhotoBrainAPIError, .invalidRequest)
            }
        }
        XCTAssertTrue(StubURLProtocol.requests.isEmpty)
    }

    func testClientMapsNotFoundEnvelopeToServerError() async {
        StubURLProtocol.respond(
            status: 404,
            body: #"{"error":{"code":"PHOTO_NOT_FOUND","message":"Photo not found"}}"#
        )
        do {
            _ = try await makeClient().similarPhotos(id: 77, limit: 30)
            XCTFail("Expected a server error")
        } catch {
            XCTAssertEqual(
                error as? PhotoBrainAPIError,
                .server(status: 404, code: "PHOTO_NOT_FOUND", message: "Photo not found")
            )
        }
    }

    private func makeClient() -> APIClient {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [StubURLProtocol.self]
        return APIClient(
            baseURL: URL(string: "https://photos.example.test")!,
            session: URLSession(configuration: configuration)
        )
    }

    private static func photoJSON(id: Int) -> String {
        #"{"id":\#(id),"path":"synthetic/photo_\#(id).jpg","name":"photo_\#(id).jpg","size":1024,"createdAt":"2024-01-02T03:04:05.000Z","modifiedAt":"2024-01-02T03:04:06Z","width":4000,"height":3000,"mimeType":"image/jpeg","isRaw":false,"rawFormat":null,"rawStatus":null,"rawError":null,"thumbnailStatus":"completed","thumbnailUpdatedAt":"2024-01-02T03:04:07.123Z","embeddingStatus":"completed","phashStatus":"completed","exif":null}"#
    }
}

private final class StubURLProtocol: URLProtocol, @unchecked Sendable {
    private static let lock = NSLock()
    nonisolated(unsafe) private static var recorded: [URLRequest] = []
    nonisolated(unsafe) private static var response: (status: Int, body: Data) = (500, Data())

    static var requests: [URLRequest] {
        lock.lock()
        defer { lock.unlock() }
        return recorded
    }

    static func respond(status: Int, body: String) {
        lock.lock()
        response = (status, Data(body.utf8))
        lock.unlock()
    }

    static func reset() {
        lock.lock()
        recorded = []
        response = (500, Data())
        lock.unlock()
    }

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        Self.lock.lock()
        Self.recorded.append(request)
        let (status, body) = Self.response
        Self.lock.unlock()
        let http = HTTPURLResponse(
            url: request.url!,
            statusCode: status,
            httpVersion: "HTTP/1.1",
            headerFields: ["Content-Type": "application/json"]
        )!
        client?.urlProtocol(self, didReceive: http, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: body)
        client?.urlProtocolDidFinishLoading(self)
    }

    override func stopLoading() {}
}

@MainActor
final class SimilarPhotosStateTests: XCTestCase {
    func testSuccessLoadsRecordsInServerOrder() async {
        let api = TestAPI()
        await api.setSimilar(id: 1, result: .success(response(source: 1, ids: [7, 3, 9])))
        let store = SimilarPhotosStore(api: api)

        let task = store.load(sourceID: 1)
        XCTAssertEqual(store.state, .loading)
        await task?.value

        XCTAssertEqual(store.state, .loaded)
        XCTAssertEqual(store.records.map(\.id), [7, 3, 9])
        XCTAssertEqual(store.sourcePhotoID, 1)
        let requests = await api.recordedSimilarRequests()
        XCTAssertEqual(requests.map(\.id), [1])
        XCTAssertEqual(requests.map(\.limit), [SimilarPhotosStore.resultLimit])
    }

    func testSettledSourceIsNotRefetched() async {
        let api = TestAPI()
        await api.setSimilar(id: 1, result: .success(response(source: 1, ids: [2])))
        let store = SimilarPhotosStore(api: api)
        await store.load(sourceID: 1)?.value

        XCTAssertNil(store.load(sourceID: 1))
        let count = await api.recordedSimilarRequests().count
        XCTAssertEqual(count, 1)
    }

    func testIndexedWithoutNeighboursIsEmpty() async {
        let api = TestAPI()
        await api.setSimilar(id: 1, result: .success(response(source: 1, ids: [])))
        let store = SimilarPhotosStore(api: api)
        await store.load(sourceID: 1)?.value
        XCTAssertEqual(store.state, .empty)
    }

    func testNotIndexedSourceShowsNotIndexed() async {
        let api = TestAPI()
        await api.setSimilar(
            id: 4,
            result: .success(SimilarPhotosResponseDTO(photos: [], total: 0, sourcePhotoId: 4, indexed: false))
        )
        let store = SimilarPhotosStore(api: api)
        await store.load(sourceID: 4)?.value

        XCTAssertEqual(store.state, .notIndexed)
        XCTAssertTrue(store.records.isEmpty)
    }

    func testErrorThenRetrySucceeds() async {
        let api = TestAPI()
        await api.setSimilar(id: 1, result: .failure(.transport("The network connection was lost.")))
        let store = SimilarPhotosStore(api: api)
        await store.load(sourceID: 1)?.value

        XCTAssertEqual(store.state, .failed("The network connection was lost."))
        XCTAssertTrue(store.records.isEmpty)

        await api.setSimilar(id: 1, result: .success(response(source: 1, ids: [5, 6])))
        let retry = store.retry()
        XCTAssertEqual(store.state, .loading)
        await retry?.value

        XCTAssertEqual(store.state, .loaded)
        XCTAssertEqual(store.records.map(\.id), [5, 6])
        let count = await api.recordedSimilarRequests().count
        XCTAssertEqual(count, 2)
    }

    func testStaleResponseForPreviousSourceIsIgnored() async {
        let api = TestAPI()
        await api.setSimilar(id: 1, delay: .milliseconds(300), result: .success(response(source: 1, ids: [10, 11])))
        await api.setSimilar(id: 2, result: .success(response(source: 2, ids: [20])))
        let store = SimilarPhotosStore(api: api)

        let stale = store.load(sourceID: 1)
        let current = store.load(sourceID: 2)
        await current?.value
        await stale?.value
        // Give an uncancelled late response every chance to land.
        try? await Task.sleep(for: .milliseconds(350))

        XCTAssertEqual(store.sourcePhotoID, 2)
        XCTAssertEqual(store.state, .loaded)
        XCTAssertEqual(store.records.map(\.id), [20])
    }

    func testStaleFailureForPreviousSourceIsIgnored() async {
        let api = TestAPI()
        await api.setSimilar(id: 1, delay: .milliseconds(200), result: .failure(.transport("late failure")))
        await api.setSimilar(id: 2, result: .success(response(source: 2, ids: [21])))
        let store = SimilarPhotosStore(api: api)

        let stale = store.load(sourceID: 1)
        await store.load(sourceID: 2)?.value
        await stale?.value

        XCTAssertEqual(store.state, .loaded)
        XCTAssertEqual(store.records.map(\.id), [21])
    }

    func testCancelOnDisappearDropsInFlightResultAndReloadsOnReturn() async {
        let api = TestAPI()
        await api.setSimilar(id: 1, delay: .milliseconds(300), result: .success(response(source: 1, ids: [8])))
        let store = SimilarPhotosStore(api: api)

        let task = store.load(sourceID: 1)
        XCTAssertEqual(store.state, .loading)
        store.cancel()
        XCTAssertEqual(store.state, .idle)
        await task?.value
        try? await Task.sleep(for: .milliseconds(350))

        XCTAssertEqual(store.state, .idle)
        XCTAssertTrue(store.records.isEmpty)

        await api.setSimilar(id: 1, result: .success(response(source: 1, ids: [8])))
        let reload = store.load(sourceID: 1)
        XCTAssertNotNil(reload)
        await reload?.value
        XCTAssertEqual(store.state, .loaded)
        XCTAssertEqual(store.records.map(\.id), [8])
    }

    func testCancelAfterSettledKeepsResults() async {
        let api = TestAPI()
        await api.setSimilar(id: 1, result: .success(response(source: 1, ids: [4])))
        let store = SimilarPhotosStore(api: api)
        await store.load(sourceID: 1)?.value

        store.cancel()

        XCTAssertEqual(store.state, .loaded)
        XCTAssertEqual(store.records.map(\.id), [4])
    }

    private func response(source: Int, ids: [Int]) -> SimilarPhotosResponseDTO {
        SimilarPhotosResponseDTO(
            photos: ids.map { TestModels.photo(id: $0) },
            total: ids.count,
            sourcePhotoId: source,
            indexed: true
        )
    }
}
