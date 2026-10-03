import XCTest
@testable import PhotoBrain

@MainActor
final class SearchStateTests: XCTestCase {
    private static let raw = LibraryFilters(mediaKind: .raw, camera: "Sony A7 IV")

    func testTrimmedDebounceIsGenerationFencedAndLimitedToNewestQuery() async {
        let api = TestAPI()
        await api.setSearch(
            query: "first",
            delay: .milliseconds(500),
            response: SearchResponseDTO(photos: [TestModels.photo(id: 1)], total: 1, query: "first")
        )
        await api.setSearch(
            query: "second",
            delay: .zero,
            response: SearchResponseDTO(photos: [TestModels.photo(id: 2)], total: 1, query: "second")
        )
        let store = SearchStore(api: api)
        store.query = "  first  "
        try? await Task.sleep(for: .milliseconds(400))
        store.query = " second "
        try? await Task.sleep(for: .milliseconds(450))

        XCTAssertEqual(store.records.map(\.id), [2])
        XCTAssertEqual(store.state, .results)
    }

    func testWhitespaceOnlyQueryCancelsAndReturnsToIdle() {
        let store = SearchStore(api: TestAPI())
        store.query = "   \n "
        XCTAssertEqual(store.state, .idle)
        XCTAssertTrue(store.records.isEmpty)
    }

    func testChangingFiltersImmediatelyRerunsCurrentQueryWithThoseFilters() async {
        let api = TestAPI()
        await api.setSearch(query: "beach", delay: .zero, response: response("beach", ids: [1, 2, 3]))
        await api.setSearch(
            query: "beach",
            filters: Self.raw.photoQuery,
            delay: .zero,
            response: response("beach", ids: [3])
        )
        let store = SearchStore(api: api)
        store.query = "beach"
        await settle(store)
        XCTAssertEqual(store.records.map(\.id), [1, 2, 3])

        store.applyFilters(Self.raw)
        XCTAssertEqual(store.state, .loading, "filter changes skip the typing debounce")
        await settle(store)

        XCTAssertEqual(store.records.map(\.id), [3])
        XCTAssertEqual(store.state, .results)
        let requests = await api.recordedSearchRequests()
        XCTAssertEqual(requests.map(\.query), ["beach", "beach"])
        XCTAssertEqual(requests.map(\.filters), [PhotoQuery(), Self.raw.photoQuery])
    }

    func testApplyingIdenticalFiltersDoesNotRerunSearch() async {
        let api = TestAPI()
        let store = SearchStore(api: api)
        store.query = "beach"
        await settle(store)
        store.applyFilters(LibraryFilters())
        store.applyFilters(Self.raw)
        await settle(store)
        store.applyFilters(Self.raw)
        await settle(store)

        let requests = await api.recordedSearchRequests()
        XCTAssertEqual(requests.map(\.filters), [PhotoQuery(), Self.raw.photoQuery])
    }

    func testStaleResponseForPreviousFilterSetIsDiscarded() async {
        let api = TestAPI()
        await api.setSearch(query: "beach", delay: .milliseconds(600), response: response("beach", ids: [1]))
        await api.setSearch(
            query: "beach",
            filters: Self.raw.photoQuery,
            delay: .zero,
            response: response("beach", ids: [2])
        )
        let store = SearchStore(api: api)
        store.query = "beach"
        // Debounce has fired; the unfiltered request is in flight for another ~550 ms.
        try? await Task.sleep(for: .milliseconds(400))
        XCTAssertEqual(store.state, .loading)

        store.applyFilters(Self.raw)
        await settle(store)
        XCTAssertEqual(store.records.map(\.id), [2])

        try? await Task.sleep(for: .milliseconds(700))
        XCTAssertEqual(store.records.map(\.id), [2], "the unfiltered response arrived late and must be dropped")
        XCTAssertEqual(store.state, .results)
    }

    func testStaleResponseForPreviousQueryAndFilterComboIsDiscarded() async {
        let api = TestAPI()
        await api.setSearch(
            query: "beach",
            filters: Self.raw.photoQuery,
            delay: .milliseconds(600),
            response: response("beach", ids: [1])
        )
        await api.setSearch(query: "sunset", delay: .zero, response: response("sunset", ids: [9]))
        let store = SearchStore(api: api)
        store.applyFilters(Self.raw)
        store.query = "beach"
        try? await Task.sleep(for: .milliseconds(400))

        store.clearFilters()
        store.query = "sunset"
        try? await Task.sleep(for: .milliseconds(450))
        XCTAssertEqual(store.records.map(\.id), [9])

        try? await Task.sleep(for: .milliseconds(400))
        XCTAssertEqual(store.records.map(\.id), [9])
        let requests = await api.recordedSearchRequests()
        XCTAssertEqual(requests.last, TestAPI.SearchKey(query: "sunset", filters: PhotoQuery()))
    }

    func testClearingFiltersRerunsUnfilteredSearch() async {
        let api = TestAPI()
        await api.setSearch(query: "beach", delay: .zero, response: response("beach", ids: [1, 2]))
        await api.setSearch(
            query: "beach",
            filters: Self.raw.photoQuery,
            delay: .zero,
            response: response("beach", ids: [2])
        )
        let store = SearchStore(api: api)

        store.applyFilters(Self.raw)
        XCTAssertEqual(store.state, .idle, "filters alone never search without a query")
        let initialRequests = await api.recordedSearchRequests()
        XCTAssertTrue(initialRequests.isEmpty)

        store.query = "beach"
        await settle(store)
        XCTAssertEqual(store.records.map(\.id), [2])

        store.clearFilters()
        XCTAssertFalse(store.filters.isActive)
        await settle(store)
        XCTAssertEqual(store.records.map(\.id), [1, 2])
        let requests = await api.recordedSearchRequests()
        XCTAssertEqual(requests.map(\.filters), [Self.raw.photoQuery, PhotoQuery()])
    }

    func testFiltersWithNoMatchesReportEmptyNotFailure() async {
        let api = TestAPI()
        let store = SearchStore(api: api)
        store.query = "beach"
        store.applyFilters(LibraryFilters(iso: 51_200))
        await settle(store)

        XCTAssertEqual(store.state, .empty)
        XCTAssertTrue(store.records.isEmpty)
        let requests = await api.recordedSearchRequests()
        XCTAssertEqual(requests.map(\.filters.iso), [51_200])
    }

    func testChipFieldsAreOrderedAndRemovingOneKeepsTheRest() {
        let filters = LibraryFilters(
            mediaKind: .standard,
            camera: "Sony A7 IV",
            lens: "FE 35mm",
            iso: 400,
            dateMonth: "2024-08"
        )
        XCTAssertEqual(filters.activeFields.map(\.field), [.mediaKind, .camera, .lens, .iso, .dateMonth])
        XCTAssertEqual(
            filters.activeFields.map(\.title),
            ["Standard", "Sony A7 IV", "FE 35mm", "ISO 400", "August 2024"]
        )
        XCTAssertTrue(LibraryFilters().activeFields.isEmpty)

        let withoutLens = filters.removing(.lens)
        XCTAssertNil(withoutLens.lens)
        XCTAssertEqual(withoutLens.camera, "Sony A7 IV")
        XCTAssertEqual(withoutLens.iso, 400)
        XCTAssertEqual(filters.removing(.mediaKind).mediaKind, .all)
        XCTAssertFalse(
            [.mediaKind, .camera, .lens, .iso, .dateMonth]
                .reduce(filters) { $0.removing($1) }
                .isActive
        )
    }

    func testFilterQueryMapsEveryFieldAndNeverScopesToAFolder() {
        let filters = LibraryFilters(mediaKind: .raw, camera: "C", lens: "L", iso: 800, dateMonth: "2023-01")
        XCTAssertEqual(
            filters.photoQuery,
            PhotoQuery(filterRaw: .raw, folder: nil, camera: "C", lens: "L", iso: 800, dateMonth: "2023-01")
        )
        XCTAssertEqual(LibraryFilters().photoQuery, PhotoQuery())
    }

    private func response(_ query: String, ids: [Int]) -> SearchResponseDTO {
        SearchResponseDTO(photos: ids.map { TestModels.photo(id: $0) }, total: ids.count, query: query)
    }

    /// Waits for the store to leave its waiting/loading states.
    private func settle(_ store: SearchStore, file: StaticString = #filePath, line: UInt = #line) async {
        let deadline = ContinuousClock.now + .seconds(3)
        while store.state == .waiting || store.state == .loading {
            guard ContinuousClock.now < deadline else {
                return XCTFail("Search did not settle", file: file, line: line)
            }
            try? await Task.sleep(for: .milliseconds(20))
        }
    }
}

final class SearchRequestEncodingTests: XCTestCase {
    override func tearDown() {
        StubURLProtocol.reset()
        super.tearDown()
    }

    func testUnfilteredBodyOmitsNilFieldsAndAlwaysSendsFilterRaw() async throws {
        let body = try await sentBody(query: "  beach  ", limit: 50, filters: PhotoQuery())

        XCTAssertEqual(Set(body.keys), ["query", "limit", "filterRaw"])
        XCTAssertEqual(body["query"] as? String, "beach")
        XCTAssertEqual(body["limit"] as? Int, 50)
        XCTAssertEqual(body["filterRaw"] as? String, "all")
    }

    func testFullyFilteredBodyContainsEveryField() async throws {
        let filters = PhotoQuery(
            filterRaw: .raw,
            folder: "2024/Trip_1",
            camera: "Sony A7 IV",
            lens: "FE 35mm F1.8",
            iso: 400,
            dateMonth: "2024-08"
        )
        let body = try await sentBody(query: "beach", limit: 100, filters: filters)

        XCTAssertEqual(
            Set(body.keys),
            ["query", "limit", "filterRaw", "folder", "camera", "lens", "iso", "dateMonth"]
        )
        XCTAssertEqual(body["filterRaw"] as? String, "raw")
        XCTAssertEqual(body["folder"] as? String, "2024/Trip_1")
        XCTAssertEqual(body["camera"] as? String, "Sony A7 IV")
        XCTAssertEqual(body["lens"] as? String, "FE 35mm F1.8")
        XCTAssertEqual(body["iso"] as? Int, 400)
        XCTAssertEqual(body["dateMonth"] as? String, "2024-08")
    }

    func testPartiallyFilteredBodyContainsOnlySetFields() async throws {
        let body = try await sentBody(
            query: "beach",
            limit: 1,
            filters: PhotoQuery(filterRaw: .standard, iso: 100)
        )

        XCTAssertEqual(Set(body.keys), ["query", "limit", "filterRaw", "iso"])
        XCTAssertEqual(body["filterRaw"] as? String, "standard")
        XCTAssertEqual(body["iso"] as? Int, 100)
    }

    func testInvalidQueryOrLimitIsRejectedWithoutNetwork() async {
        let client = StubURLProtocol.makeClient()
        for (query, limit) in [("   ", 50), ("beach", 0), ("beach", 101)] {
            do {
                _ = try await client.search(query: query, limit: limit, filters: PhotoQuery(filterRaw: .raw))
                XCTFail("Expected invalidRequest for \(query.debugDescription), limit \(limit)")
            } catch {
                XCTAssertEqual(error as? PhotoBrainAPIError, .invalidRequest)
            }
        }
        XCTAssertTrue(StubURLProtocol.requests.isEmpty)
    }

    func testUnknownFilterRejectionSurfacesServerEnvelope() async {
        StubURLProtocol.respond(
            status: 400,
            body: #"{"error":{"code":"INVALID_REQUEST","message":"Invalid search request"}}"#
        )
        do {
            _ = try await StubURLProtocol.makeClient().search(query: "beach", limit: 50, filters: PhotoQuery())
            XCTFail("Expected a server error")
        } catch {
            XCTAssertEqual(
                error as? PhotoBrainAPIError,
                .server(status: 400, code: "INVALID_REQUEST", message: "Invalid search request")
            )
        }
    }

    private func sentBody(query: String, limit: Int, filters: PhotoQuery) async throws -> [String: Any] {
        StubURLProtocol.respond(status: 200, body: #"{"photos":[],"total":0,"query":"beach"}"#)
        _ = try await StubURLProtocol.makeClient().search(query: query, limit: limit, filters: filters)

        XCTAssertEqual(StubURLProtocol.requests.count, 1)
        let request = try XCTUnwrap(StubURLProtocol.requests.first)
        XCTAssertEqual(request.httpMethod, "POST")
        XCTAssertEqual(request.url?.path, "/api/v1/search")
        XCTAssertEqual(request.value(forHTTPHeaderField: "Content-Type"), "application/json")
        let data = try XCTUnwrap(request.httpBody)
        return try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
    }
}
