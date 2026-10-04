import XCTest
@testable import PhotoBrain

final class SmartAlbumDTOTests: XCTestCase {
    private let decoder = APIModelCoding.decoder()

    func testFilterAlbumWithCountAndCoverDecodes() throws {
        let json = #"{"id":3,"name":"RAW picks","filters":{"filterRaw":"raw","flag":"pick","minRating":4},"#
            + #""query":null,"photoCount":12,"cover":{"photoId":42,"thumbnailUpdatedAt":"2024-05-06T07:08:09.123Z"},"#
            + #""createdAt":"2024-01-02T03:04:05.000Z","updatedAt":"2024-01-03T03:04:05Z"}"#
        let album = try decoder.decode(SmartAlbumDTO.self, from: Data(json.utf8))

        XCTAssertEqual(album.id, 3)
        XCTAssertEqual(album.name, "RAW picks")
        XCTAssertEqual(album.filters, SmartAlbumFilters(filterRaw: .raw, minRating: 4, flag: .pick))
        XCTAssertNil(album.query)
        XCTAssertEqual(album.photoCount, 12)
        XCTAssertEqual(album.cover?.photoId, 42)
        XCTAssertEqual(album.createdAt.timeIntervalSince1970, 1_704_164_645)
        XCTAssertEqual(album.updatedAt.timeIntervalSince1970, 1_704_251_045)
        let url = try XCTUnwrap(album.coverURL(apiBaseURL: URL(string: "https://p.example")!))
        XCTAssertTrue(url.path.contains("/api/photos/42/thumbnail/medium"))
    }

    func testQueryAlbumDecodesNullCountAndCover() throws {
        let json = #"{"albums":[{"id":1,"name":"Beach","filters":{},"query":"sunset on the beach","#
            + #""photoCount":null,"cover":null,"createdAt":"2024-01-02T03:04:05Z","updatedAt":"2024-01-02T03:04:05Z"}]}"#
        let response = try decoder.decode(SmartAlbumsResponseDTO.self, from: Data(json.utf8))

        let album = try XCTUnwrap(response.albums.first)
        XCTAssertEqual(album.query, "sunset on the beach")
        XCTAssertNil(album.photoCount)
        XCTAssertNil(album.cover)
        XCTAssertNil(album.coverURL(apiBaseURL: URL(string: "https://p.example")!))
        XCTAssertTrue(album.filters.isEmpty)
    }

    func testFiltersIgnoreUnknownKeysAndValues() throws {
        let json = #"{"camera":"X100V","collectionId":9,"futureFilter":{"nested":true},"#
            + #""flag":"maybe","filterRaw":"all","iso":800}"#
        let filters = try decoder.decode(SmartAlbumFilters.self, from: Data(json.utf8))

        XCTAssertEqual(filters, SmartAlbumFilters(camera: "X100V", iso: 800))
        XCTAssertNil(filters.filterRaw, "\"all\" means no media filter")
        XCTAssertNil(filters.flag, "Unknown flag values are dropped")
    }

    func testDateMonthIsNormalizedToDashForm() throws {
        let colon = try decoder.decode(SmartAlbumFilters.self, from: Data(#"{"dateMonth":"2024:07"}"#.utf8))
        let dash = try decoder.decode(SmartAlbumFilters.self, from: Data(#"{"dateMonth":"2024-07"}"#.utf8))

        XCTAssertEqual(colon.dateMonth, "2024-07")
        XCTAssertEqual(dash.dateMonth, "2024-07")
        XCTAssertEqual(SmartAlbumFilters(dateMonth: "2023:12").dateMonth, "2023-12")
    }

    func testLibraryFiltersBecomeSavedCriteria() {
        let filters = LibraryFilters(
            mediaKind: .standard,
            camera: "A7",
            lens: nil,
            iso: 100,
            dateMonth: "2024:03",
            minRating: 3,
            flag: .unflagged,
            tag: "beach"
        )
        XCTAssertEqual(
            SmartAlbumFilters(filters),
            SmartAlbumFilters(
                filterRaw: .standard,
                camera: "A7",
                iso: 100,
                dateMonth: "2024-03",
                minRating: 3,
                flag: .unflagged,
                tag: "beach"
            )
        )
        XCTAssertTrue(SmartAlbumFilters(LibraryFilters()).isEmpty)
    }

    func testFilterAlbumRequiresCount() throws {
        let json = #"{"id":1,"name":"X","filters":{"tag":"dog"},"query":null,"photoCount":3,"cover":null,"#
            + #""createdAt":"2024-01-02T03:04:05Z","updatedAt":"2024-01-02T03:04:05Z"}"#
        XCTAssertEqual(try decoder.decode(SmartAlbumDTO.self, from: Data(json.utf8)).photoCount, 3)
        let missingFilters = #"{"id":1,"name":"X","query":null,"photoCount":3,"cover":null,"#
            + #""createdAt":"2024-01-02T03:04:05Z","updatedAt":"2024-01-02T03:04:05Z"}"#
        XCTAssertThrowsError(try decoder.decode(SmartAlbumDTO.self, from: Data(missingFilters.utf8)))
    }
}

final class SmartAlbumAPITests: XCTestCase {
    private static let albumJSON = #"{"id":4,"name":"Picks","filters":{"flag":"pick"},"query":null,"#
        + #""photoCount":2,"cover":null,"createdAt":"2024-01-02T03:04:05Z","updatedAt":"2024-01-02T03:04:05Z"}"#

    override func tearDown() {
        StubURLProtocol.reset()
        super.tearDown()
    }

    func testListIsGet() async throws {
        StubURLProtocol.respond(status: 200, body: #"{"albums":[\#(Self.albumJSON)]}"#)
        let response = try await StubURLProtocol.makeClient().smartAlbums()

        let request = try onlyRequest()
        XCTAssertEqual(request.httpMethod, "GET")
        XCTAssertEqual(request.url?.path, "/api/v1/smart-albums")
        XCTAssertNil(request.httpBody)
        XCTAssertEqual(response.albums.map(\.id), [4])
    }

    func testCreateEncodesOnlySetFiltersAndOmitsMissingQuery() async throws {
        StubURLProtocol.respond(status: 201, body: Self.albumJSON)
        _ = try await StubURLProtocol.makeClient().createSmartAlbum(
            name: "  Picks ",
            filters: SmartAlbumFilters(filterRaw: .raw, dateMonth: "2024:07", minRating: 4, flag: .pick, tag: "dog"),
            query: "   "
        )

        let request = try onlyRequest()
        XCTAssertEqual(request.httpMethod, "POST")
        XCTAssertEqual(request.url?.path, "/api/v1/smart-albums")
        XCTAssertEqual(request.value(forHTTPHeaderField: "Content-Type"), "application/json")
        let body = try jsonBody(request)
        XCTAssertEqual(Set(body.keys), ["name", "filters"])
        XCTAssertEqual(body["name"] as? String, "Picks")
        let filters = try XCTUnwrap(body["filters"] as? [String: Any])
        XCTAssertEqual(Set(filters.keys), ["filterRaw", "dateMonth", "minRating", "flag", "tag"])
        XCTAssertEqual(filters["filterRaw"] as? String, "raw")
        XCTAssertEqual(filters["dateMonth"] as? String, "2024-07")
        XCTAssertEqual(filters["minRating"] as? Int, 4)
        XCTAssertEqual(filters["flag"] as? String, "pick")
        XCTAssertEqual(filters["tag"] as? String, "dog")
    }

    func testCreateQueryAlbumSendsTrimmedQueryAndEmptyFilters() async throws {
        StubURLProtocol.respond(status: 201, body: Self.albumJSON)
        _ = try await StubURLProtocol.makeClient().createSmartAlbum(
            name: "Beach",
            filters: SmartAlbumFilters(),
            query: "  sunset on the beach \n"
        )

        let body = try jsonBody(onlyRequest())
        XCTAssertEqual(body["query"] as? String, "sunset on the beach")
        XCTAssertEqual((body["filters"] as? [String: Any])?.isEmpty, true)
    }

    func testCreateRejectsNon201Success() async {
        StubURLProtocol.respond(status: 200, body: Self.albumJSON)
        await assertThrows(.invalidResponse) {
            _ = try await StubURLProtocol.makeClient().createSmartAlbum(
                name: "Picks",
                filters: SmartAlbumFilters(flag: .pick),
                query: nil
            )
        }
    }

    func testInvalidDraftsAreRejectedWithoutRequest() async {
        let client = StubURLProtocol.makeClient()
        await assertValidation(.noCriteria) {
            _ = try await client.createSmartAlbum(name: "Empty", filters: SmartAlbumFilters(filterRaw: .all), query: " ")
        }
        await assertValidation(.emptyName) {
            _ = try await client.createSmartAlbum(name: "  ", filters: SmartAlbumFilters(flag: .pick), query: nil)
        }
        await assertValidation(.nameTooLong) {
            _ = try await client.createSmartAlbum(
                name: String(repeating: "a", count: 101),
                filters: SmartAlbumFilters(flag: .pick),
                query: nil
            )
        }
        await assertValidation(.queryTooLong) {
            _ = try await client.createSmartAlbum(
                name: "Long",
                filters: SmartAlbumFilters(),
                query: String(repeating: "q", count: 201)
            )
        }
        await assertValidation(.emptyName) { _ = try await client.renameSmartAlbum(id: 4, name: "") }
        XCTAssertTrue(StubURLProtocol.requests.isEmpty)
    }

    func testDuplicateNameMapsToReadableConflict() async {
        StubURLProtocol.respond(
            status: 409,
            body: #"{"error":{"code":"SMART_ALBUM_NAME_TAKEN","message":"A smart album with that name already exists"}}"#
        )
        do {
            _ = try await StubURLProtocol.makeClient().createSmartAlbum(
                name: "picks",
                filters: SmartAlbumFilters(flag: .pick),
                query: nil
            )
            XCTFail("Expected a conflict")
        } catch {
            XCTAssertEqual((error as? PhotoBrainAPIError)?.code, "SMART_ALBUM_NAME_TAKEN")
            XCTAssertEqual(error.localizedDescription, "A smart album with that name already exists.")
        }
    }

    func testRenameIsPatchWithNameOnly() async throws {
        StubURLProtocol.respond(status: 200, body: Self.albumJSON)
        _ = try await StubURLProtocol.makeClient().renameSmartAlbum(id: 4, name: " Picks ")

        let request = try onlyRequest()
        XCTAssertEqual(request.httpMethod, "PATCH")
        XCTAssertEqual(request.url?.path, "/api/v1/smart-albums/4")
        let body = try jsonBody(request)
        XCTAssertEqual(Set(body.keys), ["name"])
        XCTAssertEqual(body["name"] as? String, "Picks")
    }

    func testRenameMissingAlbumMapsToReadableError() async {
        StubURLProtocol.respond(
            status: 404,
            body: #"{"error":{"code":"SMART_ALBUM_NOT_FOUND","message":"Smart album not found"}}"#
        )
        do {
            _ = try await StubURLProtocol.makeClient().renameSmartAlbum(id: 4, name: "Picks")
            XCTFail("Expected not found")
        } catch {
            XCTAssertEqual((error as? PhotoBrainAPIError)?.code, "SMART_ALBUM_NOT_FOUND")
            XCTAssertEqual(error.localizedDescription, "This smart album no longer exists.")
        }
    }

    func testDeleteAcceptsEmpty204AndRejectsOtherSuccess() async throws {
        StubURLProtocol.respond(status: 204, body: "")
        try await StubURLProtocol.makeClient().deleteSmartAlbum(id: 4)

        let request = try onlyRequest()
        XCTAssertEqual(request.httpMethod, "DELETE")
        XCTAssertEqual(request.url?.path, "/api/v1/smart-albums/4")
        XCTAssertNil(request.httpBody)

        StubURLProtocol.respond(status: 200, body: "{}")
        await assertThrows(.invalidResponse) { try await StubURLProtocol.makeClient().deleteSmartAlbum(id: 4) }
    }

    func testInvalidRequestEnvelopeKeepsServerMessage() async {
        StubURLProtocol.respond(
            status: 400,
            body: #"{"error":{"code":"INVALID_REQUEST","message":"Request validation failed"}}"#
        )
        await assertThrows(.server(status: 400, code: "INVALID_REQUEST", message: "Request validation failed")) {
            _ = try await StubURLProtocol.makeClient().createSmartAlbum(
                name: "Picks",
                filters: SmartAlbumFilters(flag: .pick),
                query: nil
            )
        }
    }

    private func onlyRequest() throws -> URLRequest {
        XCTAssertEqual(StubURLProtocol.requests.count, 1)
        return try XCTUnwrap(StubURLProtocol.requests.first)
    }

    private func jsonBody(_ request: URLRequest) throws -> [String: Any] {
        let data = try XCTUnwrap(request.httpBody)
        return try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
    }

    private func assertThrows(
        _ expected: PhotoBrainAPIError,
        file: StaticString = #filePath,
        line: UInt = #line,
        _ operation: () async throws -> Void
    ) async {
        do {
            try await operation()
            XCTFail("Expected \(expected)", file: file, line: line)
        } catch {
            XCTAssertEqual(error as? PhotoBrainAPIError, expected, file: file, line: line)
        }
    }

    private func assertValidation(
        _ expected: SmartAlbumValidationError,
        file: StaticString = #filePath,
        line: UInt = #line,
        _ operation: () async throws -> Void
    ) async {
        do {
            try await operation()
            XCTFail("Expected \(expected)", file: file, line: line)
        } catch {
            XCTAssertEqual(error as? SmartAlbumValidationError, expected, file: file, line: line)
        }
    }
}

@MainActor
final class SmartAlbumsStoreTests: XCTestCase {
    private func loadedStore(_ albums: [SmartAlbumDTO]) async -> (SmartAlbumsStore, TestAPI) {
        let api = TestAPI()
        await api.setSmartAlbums(albums)
        let store = SmartAlbumsStore(api: api)
        await store.load()
        return (store, api)
    }

    private func mutations(_ api: TestAPI) async -> [TestAPI.SmartAlbumRequest] {
        await api.recordedSmartAlbumRequests().filter { $0 != .list }
    }

    func testLoadPopulatesListAndInitialFailureIsFailedState() async {
        let (store, _) = await loadedStore([
            TestModels.smartAlbum(id: 2, name: "alpha"),
            TestModels.smartAlbum(id: 1, name: "Beta", query: "dogs", photoCount: nil),
        ])
        XCTAssertEqual(store.loadState, .loaded)
        XCTAssertEqual(store.albums.map(\.name), ["alpha", "Beta"])

        let api = TestAPI()
        await api.setSmartAlbumFailure(.list, .transport("Offline"))
        let failing = SmartAlbumsStore(api: api)
        await failing.load()
        XCTAssertEqual(failing.loadState, .failed("Offline"))
    }

    func testCreateInsertsInNameOrder() async throws {
        let (store, api) = await loadedStore([
            TestModels.smartAlbum(id: 1, name: "Alpha"),
            TestModels.smartAlbum(id: 2, name: "Gamma"),
        ])
        let created = try await store.create(name: " beta ", filters: SmartAlbumFilters(tag: "dog"), query: nil)

        XCTAssertEqual(created.name, "beta")
        XCTAssertEqual(store.albums.map(\.name), ["Alpha", "beta", "Gamma"])
        let sent = await mutations(api)
        XCTAssertEqual(sent, [.create(name: "beta", filters: SmartAlbumFilters(tag: "dog"), query: nil)])
    }

    func testCreateConflictThrowsReadableErrorAndLeavesListUnchanged() async {
        let (store, _) = await loadedStore([TestModels.smartAlbum(id: 1, name: "Picks")])
        let before = store.albums
        do {
            _ = try await store.create(name: "PICKS", filters: SmartAlbumFilters(flag: .pick), query: nil)
            XCTFail("Expected a conflict")
        } catch {
            XCTAssertEqual(CollectionsStore.message(for: error), "A smart album with that name already exists.")
        }
        XCTAssertEqual(store.albums, before)
    }

    func testCreateWithoutCriteriaSendsNoRequest() async {
        let (store, api) = await loadedStore([])
        do {
            _ = try await store.create(name: "Nothing", filters: SmartAlbumFilters(), query: nil)
            XCTFail("Expected validation failure")
        } catch {
            XCTAssertEqual(error as? SmartAlbumValidationError, .noCriteria)
        }
        let sent = await mutations(api)
        XCTAssertEqual(sent, [])
    }

    func testRenameAppliesOptimisticallyBeforeServerConfirms() async throws {
        let (store, api) = await loadedStore([
            TestModels.smartAlbum(id: 1, name: "Alpha", photoCount: 3),
            TestModels.smartAlbum(id: 2, name: "Beta"),
        ])
        await api.setSmartAlbumDelay(.milliseconds(200))
        let rename = Task { await store.rename(id: 1, to: "Zulu") }
        try await waitUntil { store.albums.map(\.name) == ["Beta", "Zulu"] }
        let confirmed = await rename.value

        XCTAssertTrue(confirmed)
        XCTAssertEqual(store.albums.map(\.name), ["Beta", "Zulu"])
        XCTAssertEqual(store.album(id: 1)?.photoCount, 3)
        XCTAssertNil(store.errorMessage)
    }

    func testFailedRenameRollsBack() async throws {
        let (store, api) = await loadedStore([
            TestModels.smartAlbum(id: 1, name: "Alpha"),
            TestModels.smartAlbum(id: 2, name: "Beta"),
        ])
        let before = store.albums
        await api.setSmartAlbumDelay(.milliseconds(100))
        await api.setSmartAlbumFailure(.rename, .transport("Offline"))

        let rename = Task { await store.rename(id: 1, to: "Zulu") }
        try await waitUntil { store.album(id: 1)?.name == "Zulu" }
        let renamed = await rename.value

        XCTAssertFalse(renamed)
        XCTAssertEqual(store.albums, before)
        XCTAssertEqual(store.errorMessage, "Offline")
    }

    func testRenameConflictRollsBackWithReadableError() async {
        let (store, _) = await loadedStore([
            TestModels.smartAlbum(id: 1, name: "Alpha"),
            TestModels.smartAlbum(id: 2, name: "Beta"),
        ])
        let before = store.albums

        let renamed = await store.rename(id: 1, to: "beta")

        XCTAssertFalse(renamed)
        XCTAssertEqual(store.albums, before)
        XCTAssertEqual(store.errorMessage, "A smart album with that name already exists.")
    }

    func testBlankRenameSendsNoRequest() async {
        let (store, api) = await loadedStore([TestModels.smartAlbum(id: 1, name: "Alpha")])
        let renamed = await store.rename(id: 1, to: " ")
        XCTAssertFalse(renamed)
        XCTAssertEqual(store.errorMessage, "Enter a smart album name.")
        XCTAssertEqual(store.albums.map(\.name), ["Alpha"])
        let sent = await mutations(api)
        XCTAssertEqual(sent, [])
    }

    func testDeleteRemovesOptimisticallyAndNeverTouchesPhotos() async throws {
        let (store, api) = await loadedStore([
            TestModels.smartAlbum(id: 1, name: "Alpha"),
            TestModels.smartAlbum(id: 2, name: "Beta"),
        ])
        await api.setSmartAlbumDelay(.milliseconds(100))
        let delete = Task { await store.delete(id: 1) }
        try await waitUntil { store.albums.map(\.id) == [2] }
        let deleted = await delete.value

        XCTAssertTrue(deleted)
        XCTAssertEqual(store.albums.map(\.id), [2])
        let photoQueries = await api.recordedPhotoQueries()
        XCTAssertTrue(photoQueries.isEmpty, "Deleting a smart album must not touch photos")
    }

    func testFailedDeleteRestoresAlbumInOrder() async throws {
        let (store, api) = await loadedStore([
            TestModels.smartAlbum(id: 1, name: "Alpha"),
            TestModels.smartAlbum(id: 2, name: "Beta"),
            TestModels.smartAlbum(id: 3, name: "Gamma"),
        ])
        let before = store.albums
        await api.setSmartAlbumDelay(.milliseconds(100))
        await api.setSmartAlbumFailure(.delete, .transport("Offline"))

        let delete = Task { await store.delete(id: 2) }
        try await waitUntil { store.album(id: 2) == nil }
        let deleted = await delete.value

        XCTAssertFalse(deleted)
        XCTAssertEqual(store.albums, before)
        XCTAssertEqual(store.errorMessage, "Offline")
    }

    func testDeleteOfVanishedAlbumStaysRemovedAndRefreshes() async throws {
        let (store, api) = await loadedStore([
            TestModels.smartAlbum(id: 1, name: "Alpha"),
            TestModels.smartAlbum(id: 2, name: "Beta"),
        ])
        await api.setSmartAlbumFailure(.delete, TestAPI.smartAlbumNotFound)
        await api.setSmartAlbums([TestModels.smartAlbum(id: 2, name: "Beta")])

        let deleted = await store.delete(id: 1)

        XCTAssertFalse(deleted)
        XCTAssertEqual(store.albums.map(\.id), [2])
        XCTAssertEqual(store.errorMessage, "This smart album no longer exists.")
        try await waitUntil { await api.recordedSmartAlbumRequests().filter { $0 == .list }.count == 2 }
    }

    func testSlowListResponseCannotUndoOptimisticDelete() async throws {
        let (store, api) = await loadedStore([TestModels.smartAlbum(id: 1, name: "Alpha")])
        await api.setSmartAlbumDelay(.milliseconds(80))
        let staleLoad = Task { await store.load() }
        try await Task.sleep(for: .milliseconds(10))
        await api.setSmartAlbumDelay(.zero)

        _ = await store.delete(id: 1)
        await staleLoad.value

        XCTAssertTrue(store.albums.isEmpty)
    }
}

@MainActor
final class SmartAlbumDetailStoreTests: XCTestCase {
    func testFilterAlbumListsPhotosWithItsFilters() async {
        let api = TestAPI()
        let photos = [TestModels.photo(id: 5), TestModels.photo(id: 6)]
        await api.setPhotos(PhotosResponseDTO(photos: photos, total: 2, rawCount: 0))
        let filters = SmartAlbumFilters(filterRaw: .raw, camera: "X100V", dateMonth: "2024-07", flag: .pick)
        let detail = LibraryStore(api: api, scope: .smartAlbum(filters: filters, query: nil))

        await detail.load()

        let queries = await api.recordedPhotoQueries()
        XCTAssertEqual(queries, [filters.photoQuery])
        XCTAssertEqual(queries.first?.filterRaw, .raw)
        XCTAssertNil(queries.first?.collectionId)
        let searches = await api.recordedSearchRequests()
        XCTAssertTrue(searches.isEmpty)
        XCTAssertEqual(detail.orderedRecords.map(\.id).sorted(), [5, 6])
    }

    func testQueryAlbumSearchesWithQueryAndFilters() async {
        let api = TestAPI()
        let filters = SmartAlbumFilters(minRating: 3, tag: "beach")
        await api.setSearch(
            query: "sunset",
            filters: filters.photoQuery,
            delay: .zero,
            response: SearchResponseDTO(photos: [TestModels.photo(id: 9)], total: 1, query: "sunset")
        )
        let detail = LibraryStore(api: api, scope: .smartAlbum(filters: filters, query: "sunset"))

        await detail.load()

        let searches = await api.recordedSearchRequests()
        XCTAssertEqual(searches, [TestAPI.SearchKey(query: "sunset", filters: filters.photoQuery)])
        let queries = await api.recordedPhotoQueries()
        XCTAssertTrue(queries.isEmpty)
        XCTAssertEqual(detail.orderedRecords.map(\.id), [9])
    }

    func testQueryAlbumKeepsSearchRankingInsteadOfDateOrder() async {
        let api = TestAPI()
        // Nearest first, deliberately against capture-date and ID order.
        let ranked = [
            TestModels.photo(id: 3, taken: "2024-03-01T12:00:00Z"),
            TestModels.photo(id: 1, taken: "2024-01-01T12:00:00Z"),
            TestModels.photo(id: 2, taken: "2024-02-01T12:00:00Z"),
        ]
        await api.setSearch(
            query: "sunset",
            delay: .zero,
            response: SearchResponseDTO(photos: ranked, total: 3, query: "sunset")
        )
        let detail = LibraryStore(api: api, scope: .smartAlbum(filters: SmartAlbumFilters(), query: "sunset"))
        detail.grouping = .months

        await detail.load()

        XCTAssertEqual(detail.orderedRecords.map(\.id), [3, 1, 2])
        XCTAssertEqual(detail.sections.map { $0.photos.map(\.id) }, [[3, 1, 2]])
    }

    func testSourceSelection() {
        let filters = SmartAlbumFilters(iso: 400)
        XCTAssertEqual(
            PhotoListingSource(scope: .smartAlbum(filters: filters, query: nil), filters: LibraryFilters(mediaKind: .raw)),
            .photos(filters.photoQuery),
            "Saved filters replace the user's library filters"
        )
        XCTAssertEqual(
            PhotoListingSource(scope: .smartAlbum(filters: filters, query: "cat"), filters: LibraryFilters()),
            .search(query: "cat", limit: 100, filters: filters.photoQuery)
        )
        var scoped = LibraryFilters(mediaKind: .raw).photoQuery
        scoped.collectionId = 3
        XCTAssertEqual(
            PhotoListingSource(scope: .collection(3), filters: LibraryFilters(mediaKind: .raw)),
            .photos(scoped)
        )
        XCTAssertEqual(PhotoListingSource(scope: .library, filters: LibraryFilters()), .photos(PhotoQuery()))
    }

    func testCurationInAlbumLoupePropagatesToOtherSurfaces() async throws {
        let api = TestAPI()
        let photo = TestModels.photo(id: 5)
        await api.setPhotos(PhotosResponseDTO(photos: [photo], total: 1, rawCount: 0))
        let curation = PhotoCurationCenter(api: api)
        let library = LibraryStore(api: api, curation: curation)
        let detail = LibraryStore(
            api: api,
            curation: curation,
            scope: .smartAlbum(filters: SmartAlbumFilters(tag: "dog"), query: nil)
        )
        await library.load()
        await detail.load()

        let record = try XCTUnwrap(detail.orderedRecords.first)
        await curation.update(record, patch: CurationPatch(rating: 4, flag: .some(.pick)))?.value

        XCTAssertEqual(detail.orderedRecords.first?.rating, 4)
        XCTAssertEqual(library.orderedRecords.first?.rating, 4)
        XCTAssertEqual(library.orderedRecords.first?.flag, .pick)
        let server = await api.serverCuration(id: 5)
        XCTAssertEqual(server, PhotoCuration(rating: 4, flag: .pick))
    }

    func testAlbumScopeDoesNotLoadFilterOptionsOrReactToCollections() async throws {
        let api = TestAPI()
        await api.setPhotos(PhotosResponseDTO(photos: [TestModels.photo(id: 5)], total: 1, rawCount: 0))
        await api.setCollections([TestModels.collection(id: 3, name: "Trips", photoCount: 1)], members: [3: [5]])
        let detail = LibraryStore(api: api, scope: .smartAlbum(filters: SmartAlbumFilters(tag: "dog"), query: nil))
        let collections = CollectionsStore(api: api)
        collections.register(detail)
        await detail.load()

        try await collections.setMembership([5], collectionId: 3, isMember: false)

        XCTAssertNil(detail.filterOptions)
        XCTAssertEqual(detail.orderedRecords.map(\.id), [5])
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
