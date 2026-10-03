import XCTest
@testable import PhotoBrain

final class JunkReviewAPITests: XCTestCase {
    override func tearDown() {
        StubURLProtocol.reset()
        super.tearDown()
    }

    func testReviewResponseDecodesReasonsCursorAndCounts() throws {
        let json = #"{"photos":[\#(Self.photoJSON(id: 9, reasons: #"["screenshot","dark"]"#))],"#
            + #""nextCursor":9,"counts":{"all":12,"screenshot":3,"document":4,"blurry":5,"dark":6}}"#
        let response = try APIModelCoding.decoder().decode(JunkReviewResponseDTO.self, from: Data(json.utf8))

        XCTAssertEqual(response.photos.map(\.id), [9])
        XCTAssertEqual(response.photos.first?.junkReasons, [.screenshot, .dark])
        XCTAssertEqual(response.nextCursor, 9)
        XCTAssertEqual(response.counts, JunkCountsDTO(all: 12, screenshot: 3, document: 4, blurry: 5, dark: 6))
    }

    func testUnknownReasonsAreDroppedWithoutFailingDecode() throws {
        let json = #"{"photos":[\#(Self.photoJSON(id: 3, reasons: #"["duplicate","blurry","overexposed"]"#))],"#
            + #""nextCursor":null,"counts":{"all":1,"screenshot":0,"document":0,"blurry":1,"dark":0,"duplicate":1}}"#
        let response = try APIModelCoding.decoder().decode(JunkReviewResponseDTO.self, from: Data(json.utf8))

        XCTAssertEqual(response.photos.first?.junkReasons, [.blurry])
        XCTAssertNil(response.nextCursor)
        XCTAssertEqual(response.counts.all, 1)
    }

    func testPhotoWithoutJunkReasonsDecodesAsEmpty() throws {
        let photo = try APIModelCoding.decoder().decode(PhotoDTO.self, from: Data(Self.photoJSON(id: 4, reasons: nil).utf8))
        XCTAssertEqual(photo.junkReasons, [])
        let record = PhotoRecord(dto: TestModels.photo(id: 4, junkReasons: [.document]), apiBaseURL: URL(string: "https://photos.example.invalid")!)
        XCTAssertEqual(record.junkReasons, [.document])
    }

    func testReasonLabelsMatchContract() {
        XCTAssertEqual(JunkReason.allCases.map(\.title), ["Screenshots", "Documents", "Blurry", "Too dark"])
    }

    func testJunkReviewSendsOnlyLimitWhenReasonAndCursorUnset() async throws {
        StubURLProtocol.respond(status: 200, body: Self.emptyReview)
        _ = try await StubURLProtocol.makeClient().junkReview(reason: nil, limit: 200, cursor: nil)

        let request = try XCTUnwrap(StubURLProtocol.requests.first)
        XCTAssertEqual(request.httpMethod, "GET")
        XCTAssertEqual(request.url?.path, "/api/v1/review/junk")
        XCTAssertEqual(try queryItems(of: request), [URLQueryItem(name: "limit", value: "200")])
    }

    func testJunkReviewSendsReasonAndCursorWhenSet() async throws {
        StubURLProtocol.respond(status: 200, body: Self.emptyReview)
        _ = try await StubURLProtocol.makeClient().junkReview(reason: .dark, limit: 50, cursor: 812)

        let items = try queryItems(of: XCTUnwrap(StubURLProtocol.requests.first))
        XCTAssertEqual(
            Dictionary(uniqueKeysWithValues: items.map { ($0.name, $0.value) }),
            ["reason": "dark", "limit": "50", "cursor": "812"]
        )
    }

    func testJunkReviewRejectsOutOfRangeLimitAndCursorWithoutNetwork() async {
        let invalid: [(Int, Int?)] = [(0, nil), (501, nil), (10, 0), (10, -4)]
        for (limit, cursor) in invalid {
            do {
                _ = try await StubURLProtocol.makeClient().junkReview(reason: nil, limit: limit, cursor: cursor)
                XCTFail("Expected invalid request for limit \(limit), cursor \(String(describing: cursor))")
            } catch {
                XCTAssertEqual(error as? PhotoBrainAPIError, .invalidRequest)
            }
        }
        XCTAssertTrue(StubURLProtocol.requests.isEmpty)
    }

    func testJunkReviewMapsInvalidRequestEnvelope() async {
        StubURLProtocol.respond(
            status: 400,
            body: #"{"error":{"code":"INVALID_REQUEST","message":"Invalid reason"}}"#
        )
        do {
            _ = try await StubURLProtocol.makeClient().junkReview(reason: .blurry, limit: 10, cursor: nil)
            XCTFail("Expected a server error")
        } catch {
            XCTAssertEqual(
                error as? PhotoBrainAPIError,
                .server(status: 400, code: "INVALID_REQUEST", message: "Invalid reason")
            )
        }
    }

    func testResolvePostsIdsAndActionAndDecodesUpdated() async throws {
        StubURLProtocol.respond(status: 200, body: #"{"updated":[3,7]}"#)
        let response = try await StubURLProtocol.makeClient().resolveJunk(ids: [3, 7, 99], action: .keep)

        let request = try XCTUnwrap(StubURLProtocol.requests.first)
        XCTAssertEqual(request.httpMethod, "POST")
        XCTAssertEqual(request.url?.path, "/api/v1/review/junk/resolve")
        let body = try XCTUnwrap(JSONSerialization.jsonObject(with: XCTUnwrap(request.httpBody)) as? [String: Any])
        XCTAssertEqual(body["photoIds"] as? [Int], [3, 7, 99])
        XCTAssertEqual(body["action"] as? String, "keep")
        XCTAssertEqual(Set(body.keys), ["photoIds", "action"])
        XCTAssertEqual(response.updated, [3, 7])
    }

    func testResolveRejectsEmptyOversizedOrNonPositiveBatchesWithoutNetwork() async {
        let batches: [[Int]] = [[], Array(1...501), [4, 0], [-1]]
        for ids in batches {
            do {
                _ = try await StubURLProtocol.makeClient().resolveJunk(ids: ids, action: .reject)
                XCTFail("Expected invalid request for \(ids.count) ids")
            } catch {
                XCTAssertEqual(error as? PhotoBrainAPIError, .invalidRequest)
            }
        }
        XCTAssertTrue(StubURLProtocol.requests.isEmpty)
    }

    private static let emptyReview =
        #"{"photos":[],"nextCursor":null,"counts":{"all":0,"screenshot":0,"document":0,"blurry":0,"dark":0}}"#

    private static func photoJSON(id: Int, reasons: String?) -> String {
        let base = #"{"id":\#(id),"path":"synthetic/photo_\#(id).jpg","name":"photo_\#(id).jpg","size":1024,"#
            + #""createdAt":"2024-01-02T03:04:05.000Z","modifiedAt":"2024-01-02T03:04:06Z","#
            + #""width":4000,"height":3000,"mimeType":"image/jpeg","isRaw":false,"exif":null,"rating":0,"flag":null"#
        guard let reasons else { return base + "}" }
        return base + #","junkReasons":\#(reasons)}"#
    }

    private func queryItems(of request: URLRequest) throws -> [URLQueryItem] {
        URLComponents(url: try XCTUnwrap(request.url), resolvingAgainstBaseURL: false)?.queryItems ?? []
    }
}

@MainActor
final class ReviewStoreTests: XCTestCase {
    private static let failure = PhotoBrainAPIError.server(status: 500, code: "INTERNAL", message: "Review failed")

    func testLoadShowsFirstPageAndServerCounts() async {
        let api = TestAPI()
        let candidates = Self.candidates([
            (5, [.screenshot]), (4, [.document, .blurry]), (3, [.dark]),
        ])
        await api.setJunkCandidates(candidates)
        let store = ReviewStore(api: api)

        await store.load().value

        XCTAssertEqual(store.state, .loaded)
        XCTAssertEqual(store.records.map(\.id), [5, 4, 3])
        XCTAssertEqual(store.records[1].junkReasons, [.document, .blurry])
        XCTAssertNil(store.nextCursor)
        XCTAssertEqual(store.counts, JunkCountsDTO(all: 3, screenshot: 1, document: 1, blurry: 1, dark: 1))
        let requests = await api.recordedJunkReviewRequests()
        XCTAssertEqual(requests, [.init(reason: nil, limit: ReviewStore.pageSize, cursor: nil)])
    }

    func testEmptyReviewIsNothingToReview() async {
        let api = TestAPI()
        let store = ReviewStore(api: api)

        await store.load().value

        XCTAssertEqual(store.state, .loaded)
        XCTAssertTrue(store.isEmpty)
        XCTAssertEqual(store.counts, .zero)
        XCTAssertNil(store.loadMore(), "No cursor means no further page")
    }

    func testLoadFailureWithoutContentShowsFailedState() async {
        let api = TestAPI()
        await api.setJunkReviewFailure(Self.failure)
        let store = ReviewStore(api: api)

        await store.load().value

        XCTAssertEqual(store.state, .failed("Review failed"))
        XCTAssertFalse(store.isEmpty)
    }

    func testSwitchingReasonReloadsFirstPageWithReason() async throws {
        let api = TestAPI()
        await api.setJunkCandidates(Self.candidates([(9, [.blurry]), (8, [.dark]), (7, [.blurry, .dark])]))
        let store = ReviewStore(api: api)
        await store.load().value
        store.beginSelection()
        store.activate(9)

        store.setReason(.blurry)

        XCTAssertEqual(store.state, .loading)
        XCTAssertTrue(store.records.isEmpty, "Switching reason never shows the previous reason's photos")
        XCTAssertFalse(store.isSelecting)
        try await waitUntil { store.state == .loaded }
        XCTAssertEqual(store.reason, .blurry)
        XCTAssertEqual(store.records.map(\.id), [9, 7])
        XCTAssertEqual(store.counts.all, 3, "Counts cover every candidate regardless of reason")
        let requests = await api.recordedJunkReviewRequests()
        XCTAssertEqual(requests.last, .init(reason: .blurry, limit: ReviewStore.pageSize, cursor: nil))

        store.setReason(.blurry)
        let afterRepeat = await api.recordedJunkReviewRequests()
        XCTAssertEqual(afterRepeat.count, requests.count, "Re-selecting the same reason does not reload")

        store.setReason(nil)
        try await waitUntil { store.state == .loaded && store.records.count == 3 }
        let final = await api.recordedJunkReviewRequests()
        XCTAssertEqual(final.last, .init(reason: nil, limit: ReviewStore.pageSize, cursor: nil))
    }

    func testSlowResponseForPreviousReasonNeverReplacesNewList() async throws {
        let api = TestAPI()
        await api.setJunkCandidates(Self.candidates([(2, [.blurry]), (1, [.dark])]))
        await api.setJunkReviewDelay(.milliseconds(200), for: nil)
        let store = ReviewStore(api: api)

        let first = store.load()
        store.setReason(.blurry)
        try await waitUntil { store.state == .loaded }
        await first.value
        try await Task.sleep(for: .milliseconds(250))

        XCTAssertEqual(store.reason, .blurry)
        XCTAssertEqual(store.records.map(\.id), [2])
        XCTAssertNil(store.errorMessage)
    }

    func testPaginationAppendsNextPageUsingCursor() async {
        let api = TestAPI()
        let ids = Array((1...250).reversed())
        await api.setJunkCandidates(ids.map { TestModels.photo(id: $0, junkReasons: [.blurry]) })
        let store = ReviewStore(api: api)

        await store.load().value
        XCTAssertEqual(store.records.count, 200)
        XCTAssertEqual(store.nextCursor, 51)

        await store.loadMore()?.value

        XCTAssertEqual(store.records.map(\.id), ids)
        XCTAssertNil(store.nextCursor)
        XCTAssertFalse(store.isLoadingMore)
        let requests = await api.recordedJunkReviewRequests()
        XCTAssertEqual(requests.last, .init(reason: nil, limit: ReviewStore.pageSize, cursor: 51))
    }

    func testPaginationSkipsPhotosAlreadyListed() async {
        let api = TestAPI()
        let counts = JunkCountsDTO(all: 5, screenshot: 5, document: 0, blurry: 0, dark: 0)
        await api.scriptJunkResponses([
            JunkReviewResponseDTO(photos: [5, 4, 3].map { TestModels.photo(id: $0, junkReasons: [.screenshot]) }, nextCursor: 3, counts: counts),
            JunkReviewResponseDTO(photos: [4, 3, 2, 1, 1].map { TestModels.photo(id: $0, junkReasons: [.screenshot]) }, nextCursor: nil, counts: counts),
        ])
        let store = ReviewStore(api: api)

        await store.load().value
        await store.loadMore()?.value

        XCTAssertEqual(store.records.map(\.id), [5, 4, 3, 2, 1])
        XCTAssertEqual(Set(store.records.map(\.id)).count, store.records.count)
    }

    func testLoadMoreFailureKeepsListAndSurfacesError() async {
        let api = TestAPI()
        await api.setJunkCandidates((1...210).reversed().map { TestModels.photo(id: $0, junkReasons: [.dark]) })
        let store = ReviewStore(api: api)
        await store.load().value
        await api.setJunkReviewFailure(Self.failure)

        await store.loadMore()?.value

        XCTAssertEqual(store.records.count, 200)
        XCTAssertEqual(store.nextCursor, 11, "The cursor is kept so the page can be retried")
        XCTAssertEqual(store.errorMessage, "Review failed")
        XCTAssertEqual(store.state, .loaded)
    }

    func testResolveRemovesOptimisticallyAndDecrementsCounts() async {
        let api = TestAPI()
        await api.setJunkCandidates(Self.candidates([(5, [.screenshot]), (4, [.document, .blurry]), (3, [.dark])]))
        await api.setResolve(delay: .milliseconds(150))
        let store = ReviewStore(api: api)
        await store.load().value

        let task = store.resolve([4], action: .reject)

        XCTAssertEqual(store.records.map(\.id), [5, 3], "Removed before the server answers")
        XCTAssertEqual(store.counts, JunkCountsDTO(all: 2, screenshot: 1, document: 0, blurry: 0, dark: 1))
        await task?.value
        XCTAssertEqual(store.records.map(\.id), [5, 3])
        XCTAssertEqual(store.counts, JunkCountsDTO(all: 2, screenshot: 1, document: 0, blurry: 0, dark: 1))
        XCTAssertNil(store.errorMessage)
        let resolved = await api.serverResolvedJunk()
        XCTAssertEqual(resolved, [4: .reject])
        let requests = await api.recordedResolveRequests()
        XCTAssertEqual(requests, [.init(ids: [4], action: .reject)])
    }

    func testResolveFailureRestoresOrderCountsAndSurfacesError() async {
        let api = TestAPI()
        await api.setJunkCandidates(Self.candidates([(6, [.dark]), (5, [.screenshot]), (4, [.blurry]), (3, [.document])]))
        await api.setResolve(delay: .milliseconds(100), failure: Self.failure)
        let store = ReviewStore(api: api)
        await store.load().value
        let originalCounts = store.counts

        let task = store.resolve([5, 3], action: .keep)
        XCTAssertEqual(store.records.map(\.id), [6, 4])
        XCTAssertEqual(store.counts.all, 2)
        await task?.value

        XCTAssertEqual(store.records.map(\.id), [6, 5, 4, 3], "Failed photos return to their original positions")
        XCTAssertEqual(store.counts, originalCounts)
        XCTAssertEqual(store.errorMessage, "Review failed")
        let resolved = await api.serverResolvedJunk()
        XCTAssertTrue(resolved.isEmpty)
    }

    func testResolveIgnoresIdsThatAreNotListed() async {
        let api = TestAPI()
        await api.setJunkCandidates(Self.candidates([(2, [.dark]), (1, [.dark])]))
        let store = ReviewStore(api: api)
        await store.load().value

        XCTAssertNil(store.resolve([99], action: .reject))
        let task = store.resolve([99, 1], action: .reject)
        await task?.value

        let requests = await api.recordedResolveRequests()
        XCTAssertEqual(requests, [.init(ids: [1], action: .reject)])
        XCTAssertEqual(store.records.map(\.id), [2])
    }

    func testRejectAllActsOnLoadedIdsOnlyThenLoadsRemainder() async throws {
        let api = TestAPI()
        let ids = Array((1...250).reversed())
        await api.setJunkCandidates(ids.map { TestModels.photo(id: $0, junkReasons: [.blurry]) })
        let store = ReviewStore(api: api)
        await store.load().value
        let loaded = store.records.map(\.id)

        await store.resolveAll(.reject)?.value

        let requests = await api.recordedResolveRequests()
        XCTAssertEqual(requests, [.init(ids: loaded, action: .reject)])
        XCTAssertEqual(loaded, Array(ids.prefix(200)))
        let resolved = await api.serverResolvedJunk()
        XCTAssertEqual(Set(resolved.keys), Set(loaded), "Photos past the loaded page are untouched")
        try await waitUntil { store.records.count == 50 }
        XCTAssertEqual(store.records.map(\.id), Array(ids.suffix(50)))
        XCTAssertEqual(store.counts.all, 50)
    }

    func testKeepAllEmptiesListIntoNothingToReview() async {
        let api = TestAPI()
        await api.setJunkCandidates(Self.candidates([(2, [.dark]), (1, [.screenshot])]))
        let store = ReviewStore(api: api)
        await store.load().value

        await store.resolveAll(.keep)?.value

        XCTAssertTrue(store.isEmpty)
        XCTAssertEqual(store.counts, .zero)
        let resolved = await api.serverResolvedJunk()
        XCTAssertEqual(resolved, [2: .keep, 1: .keep])
    }

    func testResolveSelectedActsOnSelectionAndEndsSelectMode() async {
        let api = TestAPI()
        await api.setJunkCandidates(Self.candidates([(3, [.dark]), (2, [.dark]), (1, [.dark])]))
        let store = ReviewStore(api: api)
        await store.load().value
        store.beginSelection()
        store.activate(3)
        store.activate(1)
        store.activate(3)
        store.activate(2)

        await store.resolveSelected(.keep)?.value

        XCTAssertFalse(store.isSelecting)
        XCTAssertTrue(store.selectedIDs.isEmpty)
        XCTAssertEqual(store.records.map(\.id), [3])
        let requests = await api.recordedResolveRequests()
        XCTAssertEqual(requests, [.init(ids: [2, 1], action: .keep)])
    }

    func testPageLoadNeverReaddsPhotoWithResolveInFlight() async throws {
        let api = TestAPI()
        await api.setJunkCandidates(Self.candidates([(3, [.dark]), (2, [.dark]), (1, [.dark])]))
        await api.setResolve(delay: .milliseconds(200))
        let store = ReviewStore(api: api)
        await store.load().value

        let resolve = store.resolve([2], action: .reject)
        await store.load().value

        XCTAssertEqual(store.records.map(\.id), [3, 1])
        XCTAssertEqual(store.counts.all, 2, "Server counts that predate the decision are not adopted")
        await resolve?.value
        try await waitUntil { await api.recordedJunkReviewRequests().count == 3 }
        XCTAssertEqual(store.counts.all, 2)
    }

    func testRejectPublishesRejectFlagToOtherStores() async {
        let api = TestAPI()
        await api.setJunkCandidates(Self.candidates([(2, [.dark]), (1, [.dark])]))
        let curation = PhotoCurationCenter(api: api)
        let spy = CurationSpy()
        curation.register(spy)
        let store = ReviewStore(api: api, curation: curation)
        await store.load().value

        await store.resolve([2], action: .reject)?.value
        await store.resolve([1], action: .keep)?.value

        XCTAssertEqual(spy.applied.map(\.id), [2])
        XCTAssertEqual(spy.applied.first?.curation.flag, .reject)
    }

    func testLoupeResolveAdvancesToNextPhotoThenClosesWhenNoneLeft() async {
        let api = TestAPI()
        await api.setJunkCandidates(Self.candidates([(5, [.dark]), (4, [.dark]), (3, [.dark])]))
        let store = ReviewStore(api: api)
        await store.load().value
        store.activate(4)
        XCTAssertEqual(store.activePhotoID, 4)

        await store.resolveActive(.reject)?.value
        XCTAssertEqual(store.activePhotoID, 3, "Advances to the photo that took its place")

        await store.resolveActive(.keep)?.value
        XCTAssertEqual(store.activePhotoID, 5, "At the end it falls back to the previous photo")

        await store.resolveActive(.keep)?.value
        XCTAssertNil(store.activePhotoID, "The loupe closes once nothing is left")
        XCTAssertTrue(store.isEmpty)
    }

    func testLoupeResolveWithoutActivePhotoDoesNothing() async {
        let api = TestAPI()
        await api.setJunkCandidates(Self.candidates([(1, [.dark])]))
        let store = ReviewStore(api: api)
        await store.load().value

        XCTAssertNil(store.resolveActive(.reject))
        let requests = await api.recordedResolveRequests()
        XCTAssertTrue(requests.isEmpty)
    }

    func testRefreshCountsAdoptsServerCountsWithoutChangingList() async {
        let api = TestAPI()
        await api.setJunkCandidates(Self.candidates([(2, [.screenshot]), (1, [.document])]))
        let store = ReviewStore(api: api)

        await store.refreshCounts()

        XCTAssertEqual(store.counts, JunkCountsDTO(all: 2, screenshot: 1, document: 1, blurry: 0, dark: 0))
        XCTAssertTrue(store.records.isEmpty)
        XCTAssertEqual(store.state, .idle)
        let requests = await api.recordedJunkReviewRequests()
        XCTAssertEqual(requests, [.init(reason: nil, limit: 1, cursor: nil)])
    }

    private static func candidates(_ specs: [(Int, [JunkReason])]) -> [PhotoDTO] {
        specs.map { TestModels.photo(id: $0.0, junkReasons: $0.1) }
    }
}

@MainActor
private final class CurationSpy: CurationApplying {
    private(set) var applied: [(id: Int, curation: PhotoCuration)] = []

    func applyCuration(id: Int, curation: PhotoCuration) {
        applied.append((id, curation))
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
