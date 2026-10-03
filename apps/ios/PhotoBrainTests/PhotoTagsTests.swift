import XCTest
@testable import PhotoBrain

final class PhotoTagsAPITests: XCTestCase {
    override func tearDown() {
        StubURLProtocol.reset()
        super.tearDown()
    }

    func testFilterOptionsDecodeTagsWithCounts() throws {
        let json = #"{"cameras":["X100V"],"lenses":[],"isos":[200],"dates":["2024-05"],"tags":[{"tag":"beach","count":12},{"tag":"night-sky","count":3}]}"#
        let options = try APIModelCoding.decoder().decode(FilterOptionsDTO.self, from: Data(json.utf8))
        XCTAssertEqual(options.cameras, ["X100V"])
        XCTAssertEqual(options.isos, [200])
        XCTAssertEqual(options.tags, [TagCountDTO(tag: "beach", count: 12), TagCountDTO(tag: "night-sky", count: 3)])
    }

    func testFilterOptionsFromOlderServerWithoutTagsDecodeAsEmpty() throws {
        let json = #"{"cameras":[],"lenses":["35mm"],"isos":[],"dates":[]}"#
        let options = try APIModelCoding.decoder().decode(FilterOptionsDTO.self, from: Data(json.utf8))
        XCTAssertEqual(options.lenses, ["35mm"])
        XCTAssertEqual(options.tags, [])
    }

    func testFilterOptionsStillRequireExistingFields() {
        let json = #"{"cameras":[],"lenses":[],"isos":[],"tags":[]}"#
        XCTAssertThrowsError(try APIModelCoding.decoder().decode(FilterOptionsDTO.self, from: Data(json.utf8)))
    }

    func testPhotoTagsRequestsTagsPathAndDecodesScores() async throws {
        StubURLProtocol.respond(
            status: 200,
            body: #"{"tags":[{"tag":"sunset","score":0.8123},{"tag":"beach","score":0.1}]}"#
        )
        let response = try await StubURLProtocol.makeClient().photoTags(id: 42)

        let request = try XCTUnwrap(StubURLProtocol.requests.first)
        XCTAssertEqual(StubURLProtocol.requests.count, 1)
        XCTAssertEqual(request.httpMethod, "GET")
        XCTAssertEqual(request.url?.path, "/api/v1/photos/42/tags")
        XCTAssertNil(request.url?.query)
        XCTAssertEqual(response.tags.map(\.tag), ["sunset", "beach"])
        XCTAssertEqual(response.tags.first?.score ?? 0, 0.8123, accuracy: 0.000_01)
    }

    func testPhotoTagsMissingPhotoMapsServerEnvelope() async {
        StubURLProtocol.respond(
            status: 404,
            body: #"{"error":{"code":"PHOTO_NOT_FOUND","message":"Photo not found"}}"#
        )
        do {
            _ = try await StubURLProtocol.makeClient().photoTags(id: 999)
            XCTFail("Expected a server error")
        } catch {
            XCTAssertEqual(
                error as? PhotoBrainAPIError,
                .server(status: 404, code: "PHOTO_NOT_FOUND", message: "Photo not found")
            )
            XCTAssertEqual((error as? LocalizedError)?.errorDescription, "Photo not found")
        }
    }

    func testPhotoTagsRejectsNonPositiveIDWithoutNetwork() async {
        for id in [0, -3] {
            do {
                _ = try await StubURLProtocol.makeClient().photoTags(id: id)
                XCTFail("Expected invalid request for id \(id)")
            } catch {
                XCTAssertEqual(error as? PhotoBrainAPIError, .invalidRequest)
            }
        }
        XCTAssertTrue(StubURLProtocol.requests.isEmpty)
    }

    func testTagIsEncodedIntoPhotosQueryWhenSet() async throws {
        StubURLProtocol.respond(status: 200, body: #"{"photos":[],"total":0,"rawCount":0}"#)
        _ = try await StubURLProtocol.makeClient().photos(query: PhotoQuery(minRating: 2, tag: "night-sky"))

        let items = try queryItems(of: XCTUnwrap(StubURLProtocol.requests.first))
        XCTAssertEqual(items.first { $0.name == "tag" }?.value, "night-sky")
        XCTAssertEqual(items.first { $0.name == "minRating" }?.value, "2")
    }

    func testUnsetTagIsOmittedFromPhotosQuery() async throws {
        StubURLProtocol.respond(status: 200, body: #"{"photos":[],"total":0,"rawCount":0}"#)
        _ = try await StubURLProtocol.makeClient().photos(query: PhotoQuery(flag: .pick))

        let items = try queryItems(of: XCTUnwrap(StubURLProtocol.requests.first))
        XCTAssertEqual(items.map(\.name), ["filterRaw", "flag"])
    }

    func testTagIsSentInSearchBodyWhenSet() async throws {
        let body = try await sentSearchBody(filters: PhotoQuery(tag: "beach"))
        XCTAssertEqual(body["tag"] as? String, "beach")
        XCTAssertEqual(body["query"] as? String, "waves")
    }

    func testUnsetTagIsOmittedFromSearchBody() async throws {
        let body = try await sentSearchBody(filters: PhotoQuery(camera: "X100V"))
        XCTAssertNil(body["tag"])
        XCTAssertEqual(Set(body.keys), ["query", "limit", "filterRaw", "camera"])
    }

    private func sentSearchBody(filters: PhotoQuery) async throws -> [String: Any] {
        StubURLProtocol.respond(status: 200, body: #"{"photos":[],"total":0,"query":"waves"}"#)
        _ = try await StubURLProtocol.makeClient().search(query: "waves", limit: 10, filters: filters)
        let request = try XCTUnwrap(StubURLProtocol.requests.first)
        XCTAssertEqual(request.url?.path, "/api/v1/search")
        let data = try XCTUnwrap(request.httpBody)
        return try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
    }

    private func queryItems(of request: URLRequest) throws -> [URLQueryItem] {
        URLComponents(url: try XCTUnwrap(request.url), resolvingAgainstBaseURL: false)?.queryItems ?? []
    }
}

final class PhotoTagNameTests: XCTestCase {
    func testDisplayNameTitleCasesFirstWordAndReplacesHyphens() {
        XCTAssertEqual(PhotoTagName.displayName("night-sky"), "Night sky")
        XCTAssertEqual(PhotoTagName.displayName("beach"), "Beach")
        XCTAssertEqual(PhotoTagName.displayName("road-trip"), "Road trip")
        XCTAssertEqual(PhotoTagName.displayName("a-b-c"), "A b c")
    }

    func testDisplayNameBoundaries() {
        XCTAssertEqual(PhotoTagName.displayName(""), "")
        XCTAssertEqual(PhotoTagName.displayName("x"), "X")
        XCTAssertEqual(PhotoTagName.displayName("-night--sky-"), "Night sky")
        XCTAssertEqual(PhotoTagName.displayName("---"), "---")
    }

    func testHashtagKeepsSlug() {
        XCTAssertEqual(PhotoTagName.hashtag("night-sky"), "#night-sky")
    }
}

final class TagFilterTests: XCTestCase {
    func testTagFilterIsActiveSummarizedAndQueried() {
        let filters = LibraryFilters(tag: "beach")
        XCTAssertTrue(filters.isActive)
        XCTAssertEqual(filters.summary, "#beach")
        XCTAssertEqual(filters.activeFields.map(\.field), [.tag])
        XCTAssertEqual(filters.photoQuery, PhotoQuery(tag: "beach"))
    }

    func testTagChipFollowsOtherFiltersAndRemovesIndependently() {
        let filters = LibraryFilters(mediaKind: .raw, minRating: 3, tag: "night-sky")
        XCTAssertEqual(filters.summary, "RAW, ★★★+, #night-sky")
        XCTAssertEqual(filters.activeFields.last, LibraryFilters.ActiveFilter(field: .tag, title: "#night-sky"))

        let removed = filters.removing(.tag)
        XCTAssertNil(removed.tag)
        XCTAssertEqual(removed.summary, "RAW, ★★★+")
        XCTAssertNil(removed.photoQuery.tag)
        XCTAssertEqual(filters.removing(.minRating).tag, "night-sky")
    }

    func testClearRemovesTag() {
        var filters = LibraryFilters(flag: .pick, tag: "dog")
        filters.clear()
        XCTAssertNil(filters.tag)
        XCTAssertFalse(filters.isActive)
        XCTAssertEqual(filters.summary, "All Items")
    }
}

@MainActor
final class TagSelectionStoreTests: XCTestCase {
    private func loadedLibrary(api: TestAPI) async -> LibraryStore {
        let photos = [TestModels.photo(id: 1), TestModels.photo(id: 2)]
        await api.setPhotos(PhotosResponseDTO(photos: photos, total: photos.count, rawCount: 0))
        let store = LibraryStore(api: api)
        await store.load()
        return store
    }

    private func waitForLastQuery(_ expected: PhotoQuery, api: TestAPI) async throws {
        let deadline = ContinuousClock.now + .seconds(3)
        while await api.recordedPhotoQueries().last != expected {
            guard ContinuousClock.now < deadline else {
                XCTFail("Timed out waiting for query \(expected)")
                return
            }
            try await Task.sleep(for: .milliseconds(10))
        }
    }

    func testLibraryLoadsTagOptionsFromFilterOptions() async {
        let api = TestAPI()
        await api.setFilterOptions(FilterOptionsDTO(
            cameras: [],
            lenses: [],
            isos: [],
            dates: [],
            tags: [TagCountDTO(tag: "beach", count: 9), TagCountDTO(tag: "dog", count: 2)]
        ))
        let store = await loadedLibrary(api: api)
        XCTAssertEqual(store.filterOptions?.tags.map(\.tag), ["beach", "dog"])
        XCTAssertEqual(store.filterOptions?.tags.map(\.count), [9, 2])
    }

    func testSelectingLoupeChipClosesLoupeSetsTagAndReloads() async throws {
        let api = TestAPI()
        let store = await loadedLibrary(api: api)
        store.applyFilters(LibraryFilters(minRating: 2))
        try await waitForLastQuery(PhotoQuery(minRating: 2), api: api)
        store.activePhotoID = 2

        store.showTag("night-sky")

        XCTAssertNil(store.activePhotoID)
        XCTAssertEqual(store.filters, LibraryFilters(minRating: 2, tag: "night-sky"))
        XCTAssertEqual(store.filters.summary, "★★+, #night-sky")
        try await waitForLastQuery(PhotoQuery(minRating: 2, tag: "night-sky"), api: api)
    }

    func testSelectingDifferentChipReplacesTagAndClearRemovesIt() async throws {
        let api = TestAPI()
        let store = await loadedLibrary(api: api)
        store.showTag("beach")
        try await waitForLastQuery(PhotoQuery(tag: "beach"), api: api)
        store.showTag("dog")
        try await waitForLastQuery(PhotoQuery(tag: "dog"), api: api)
        XCTAssertEqual(store.filters.tag, "dog")

        store.clearFilters()
        XCTAssertNil(store.filters.tag)
        try await waitForLastQuery(PhotoQuery(), api: api)
    }

    func testSearchSendsTagFilterWithQuery() async throws {
        let api = TestAPI()
        let search = SearchStore(api: api)
        search.query = "waves"
        search.applyFilters(LibraryFilters(tag: "ocean"))
        let deadline = ContinuousClock.now + .seconds(3)
        while await api.recordedSearchRequests().last?.filters.tag != "ocean", ContinuousClock.now < deadline {
            try await Task.sleep(for: .milliseconds(10))
        }
        let last = await api.recordedSearchRequests().last
        XCTAssertEqual(last?.query, "waves")
        XCTAssertEqual(last?.filters, PhotoQuery(tag: "ocean"))
    }

    func testInfoSheetTagsLoadInScoreOrder() async {
        let api = TestAPI()
        let tags = [PhotoTagDTO(tag: "sunset", score: 0.7), PhotoTagDTO(tag: "beach", score: 0.2)]
        await api.setPhotoTags(id: 5, .success(PhotoTagsResponseDTO(tags: tags)))
        let store = PhotoTagsStore(photoID: 5, api: api)
        XCTAssertEqual(store.state, .loading)

        await store.load()

        XCTAssertEqual(store.state, .loaded(tags))
        let requests = await api.recordedPhotoTagRequests()
        XCTAssertEqual(requests, [5])
    }

    func testInfoSheetUntaggedPhotoLoadsEmpty() async {
        let api = TestAPI()
        await api.setPhotoTags(id: 5, .success(PhotoTagsResponseDTO(tags: [])))
        let store = PhotoTagsStore(photoID: 5, api: api)
        await store.load()
        XCTAssertEqual(store.state, .loaded([]))
    }

    func testInfoSheetTagFailureSurfacesMessageAndRetryRecovers() async {
        let api = TestAPI()
        let store = PhotoTagsStore(photoID: 8, api: api)
        await store.load()
        XCTAssertEqual(store.state, .failed("Photo not found"))

        await api.setPhotoTags(id: 8, .failure(.transport("The network connection was lost.")))
        await store.load()
        XCTAssertEqual(store.state, .failed("The network connection was lost."))

        let tags = [PhotoTagDTO(tag: "dog", score: 0.9)]
        await api.setPhotoTags(id: 8, .success(PhotoTagsResponseDTO(tags: tags)))
        await store.load()
        XCTAssertEqual(store.state, .loaded(tags))
        let requests = await api.recordedPhotoTagRequests()
        XCTAssertEqual(requests, [8, 8, 8])
    }
}
