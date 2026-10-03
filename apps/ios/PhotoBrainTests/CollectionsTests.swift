import XCTest
@testable import PhotoBrain

final class CollectionDTOTests: XCTestCase {
    private let decoder = APIModelCoding.decoder()

    func testCollectionWithCoverDecodes() throws {
        let json = #"{"id":3,"name":"Trips","photoCount":12,"cover":{"photoId":42,"#
            + #""thumbnailUpdatedAt":"2024-05-06T07:08:09.123Z"},"#
            + #""createdAt":"2024-01-02T03:04:05.000Z","updatedAt":"2024-01-03T03:04:05Z"}"#
        let collection = try decoder.decode(CollectionDTO.self, from: Data(json.utf8))

        XCTAssertEqual(collection.id, 3)
        XCTAssertEqual(collection.name, "Trips")
        XCTAssertEqual(collection.photoCount, 12)
        XCTAssertEqual(collection.cover?.photoId, 42)
        XCTAssertEqual(
            try XCTUnwrap(collection.cover?.thumbnailUpdatedAt).timeIntervalSince1970,
            1_714_979_289.123,
            accuracy: 0.001
        )
        XCTAssertEqual(collection.createdAt.timeIntervalSince1970, 1_704_164_645)
        XCTAssertEqual(collection.updatedAt.timeIntervalSince1970, 1_704_251_045)
    }

    func testEmptyCollectionDecodesNullCover() throws {
        let json = #"{"collections":[{"id":1,"name":"Empty","photoCount":0,"cover":null,"#
            + #""createdAt":"2024-01-02T03:04:05Z","updatedAt":"2024-01-02T03:04:05Z"}]}"#
        let response = try decoder.decode(CollectionsResponseDTO.self, from: Data(json.utf8))

        XCTAssertEqual(response.collections.count, 1)
        XCTAssertNil(response.collections[0].cover)
        XCTAssertNil(response.collections[0].coverURL(apiBaseURL: URL(string: "https://p.example")!))
    }

    func testCoverWithNullThumbnailTimestampDecodes() throws {
        let json = #"{"photoId":9,"thumbnailUpdatedAt":null}"#
        let cover = try decoder.decode(CollectionCoverDTO.self, from: Data(json.utf8))
        XCTAssertEqual(cover.photoId, 9)
        XCTAssertNil(cover.thumbnailUpdatedAt)
    }

    func testMembershipResponsesDecode() throws {
        let added = try decoder.decode(CollectionPhotosAddedDTO.self, from: Data(#"{"added":2,"photoCount":7}"#.utf8))
        let removed = try decoder.decode(CollectionPhotosRemovedDTO.self, from: Data(#"{"removed":1,"photoCount":6}"#.utf8))
        let forPhoto = try decoder.decode(PhotoCollectionsDTO.self, from: Data(#"{"collectionIds":[4,9]}"#.utf8))

        XCTAssertEqual(added, CollectionPhotosAddedDTO(added: 2, photoCount: 7))
        XCTAssertEqual(removed, CollectionPhotosRemovedDTO(removed: 1, photoCount: 6))
        XCTAssertEqual(forPhoto.collectionIds, [4, 9])
    }

    func testMissingCountFailsDecoding() {
        let json = #"{"id":1,"name":"X","cover":null,"createdAt":"2024-01-02T03:04:05Z","updatedAt":"2024-01-02T03:04:05Z"}"#
        XCTAssertThrowsError(try decoder.decode(CollectionDTO.self, from: Data(json.utf8)))
    }

    func testCoverURLUsesCoverPhotoIDAndThumbnailVersion() throws {
        let updated = Date(timeIntervalSince1970: 1_714_979_289.123)
        let collection = TestModels.collection(
            id: 5,
            name: "Trips",
            photoCount: 3,
            cover: CollectionCoverDTO(photoId: 42, thumbnailUpdatedAt: updated)
        )
        let url = try XCTUnwrap(collection.coverURL(apiBaseURL: URL(string: "https://photos.example.test")!))

        XCTAssertEqual(url.absoluteString, "https://photos.example.test/api/photos/42/thumbnail/medium?v=1714979289123")
        XCTAssertEqual(
            url,
            PhotoRecord.thumbnailURL(
                baseURL: URL(string: "https://photos.example.test")!,
                id: 42,
                size: "medium",
                updatedAt: updated
            )
        )
    }

    func testCoverURLChangesWhenCoverThumbnailIsRegenerated() throws {
        let base = URL(string: "https://photos.example.test")!
        let before = TestModels.collection(
            id: 1, name: "A", photoCount: 1,
            cover: CollectionCoverDTO(photoId: 7, thumbnailUpdatedAt: Date(timeIntervalSince1970: 100))
        )
        let after = TestModels.collection(
            id: 1, name: "A", photoCount: 1,
            cover: CollectionCoverDTO(photoId: 7, thumbnailUpdatedAt: Date(timeIntervalSince1970: 101))
        )
        XCTAssertNotEqual(before.coverURL(apiBaseURL: base), after.coverURL(apiBaseURL: base))
    }

    func testCoverURLWithoutTimestampHasNoVersion() throws {
        let collection = TestModels.collection(
            id: 1, name: "A", photoCount: 1,
            cover: CollectionCoverDTO(photoId: 8, thumbnailUpdatedAt: nil)
        )
        let url = try XCTUnwrap(collection.coverURL(apiBaseURL: URL(string: "https://photos.example.test")!))
        XCTAssertEqual(url.absoluteString, "https://photos.example.test/api/photos/8/thumbnail/medium")
    }
}

final class CollectionAPITests: XCTestCase {
    private static let collectionJSON = #"{"id":4,"name":"Trips","photoCount":2,"cover":null,"#
        + #""createdAt":"2024-01-02T03:04:05Z","updatedAt":"2024-01-02T03:04:05Z"}"#

    override func tearDown() {
        StubURLProtocol.reset()
        super.tearDown()
    }

    func testListCollectionsIsGet() async throws {
        StubURLProtocol.respond(status: 200, body: #"{"collections":[\#(Self.collectionJSON)]}"#)
        let response = try await StubURLProtocol.makeClient().collections()

        let request = try onlyRequest()
        XCTAssertEqual(request.httpMethod, "GET")
        XCTAssertEqual(request.url?.path, "/api/v1/collections")
        XCTAssertNil(request.httpBody)
        XCTAssertEqual(response.collections.map(\.id), [4])
    }

    func testCreatePostsTrimmedNameAndPhotoIDsExpecting201() async throws {
        StubURLProtocol.respond(status: 201, body: Self.collectionJSON)
        let created = try await StubURLProtocol.makeClient().createCollection(name: "  Trips \n", photoIds: [3, 5])

        let request = try onlyRequest()
        XCTAssertEqual(request.httpMethod, "POST")
        XCTAssertEqual(request.url?.path, "/api/v1/collections")
        XCTAssertEqual(request.value(forHTTPHeaderField: "Content-Type"), "application/json")
        let body = try jsonBody(request)
        XCTAssertEqual(body["name"] as? String, "Trips")
        XCTAssertEqual(body["photoIds"] as? [Int], [3, 5])
        XCTAssertEqual(Set(body.keys), ["name", "photoIds"])
        XCTAssertEqual(created.id, 4)
    }

    func testCreateWithoutPhotosOmitsPhotoIDs() async throws {
        StubURLProtocol.respond(status: 201, body: Self.collectionJSON)
        _ = try await StubURLProtocol.makeClient().createCollection(name: "Trips", photoIds: nil)

        XCTAssertEqual(Set(try jsonBody(onlyRequest()).keys), ["name"])
    }

    func testCreateRejectsNon201Success() async {
        StubURLProtocol.respond(status: 200, body: Self.collectionJSON)
        await assertThrows(.invalidResponse) {
            _ = try await StubURLProtocol.makeClient().createCollection(name: "Trips", photoIds: nil)
        }
    }

    func testDuplicateNameMapsToReadableConflict() async {
        StubURLProtocol.respond(
            status: 409,
            body: #"{"error":{"code":"COLLECTION_NAME_TAKEN","message":"Collection name already exists"}}"#
        )
        do {
            _ = try await StubURLProtocol.makeClient().createCollection(name: "trips", photoIds: nil)
            XCTFail("Expected a conflict")
        } catch {
            let apiError = error as? PhotoBrainAPIError
            XCTAssertEqual(
                apiError,
                .server(status: 409, code: "COLLECTION_NAME_TAKEN", message: "Collection name already exists")
            )
            XCTAssertEqual(apiError?.code, "COLLECTION_NAME_TAKEN")
            XCTAssertEqual(error.localizedDescription, "A collection with that name already exists.")
        }
    }

    func testRenameIsPatchWithNameOnly() async throws {
        StubURLProtocol.respond(status: 200, body: Self.collectionJSON)
        _ = try await StubURLProtocol.makeClient().renameCollection(id: 4, name: " Trips ")

        let request = try onlyRequest()
        XCTAssertEqual(request.httpMethod, "PATCH")
        XCTAssertEqual(request.url?.path, "/api/v1/collections/4")
        let body = try jsonBody(request)
        XCTAssertEqual(Set(body.keys), ["name"])
        XCTAssertEqual(body["name"] as? String, "Trips")
    }

    func testRenameConflictMapsToReadableError() async {
        StubURLProtocol.respond(
            status: 409,
            body: #"{"error":{"code":"COLLECTION_NAME_TAKEN","message":"Collection name already exists"}}"#
        )
        do {
            _ = try await StubURLProtocol.makeClient().renameCollection(id: 4, name: "Trips")
            XCTFail("Expected a conflict")
        } catch {
            XCTAssertEqual(error.localizedDescription, "A collection with that name already exists.")
        }
    }

    func testDeleteAcceptsEmpty204() async throws {
        StubURLProtocol.respond(status: 204, body: "")
        try await StubURLProtocol.makeClient().deleteCollection(id: 4)

        let request = try onlyRequest()
        XCTAssertEqual(request.httpMethod, "DELETE")
        XCTAssertEqual(request.url?.path, "/api/v1/collections/4")
        XCTAssertNil(request.httpBody)
    }

    func testDeleteRejectsNon204Success() async {
        StubURLProtocol.respond(status: 200, body: "{}")
        await assertThrows(.invalidResponse) {
            try await StubURLProtocol.makeClient().deleteCollection(id: 4)
        }
    }

    func testDeleteMissingCollectionMapsToReadableError() async {
        StubURLProtocol.respond(
            status: 404,
            body: #"{"error":{"code":"COLLECTION_NOT_FOUND","message":"Collection not found"}}"#
        )
        do {
            try await StubURLProtocol.makeClient().deleteCollection(id: 4)
            XCTFail("Expected not found")
        } catch {
            XCTAssertEqual((error as? PhotoBrainAPIError)?.code, "COLLECTION_NOT_FOUND")
            XCTAssertEqual(error.localizedDescription, "This collection no longer exists.")
        }
    }

    func testAddPhotosPostsIDs() async throws {
        StubURLProtocol.respond(status: 200, body: #"{"added":2,"photoCount":5}"#)
        let result = try await StubURLProtocol.makeClient().addPhotos(toCollection: 4, photoIds: [1, 2])

        let request = try onlyRequest()
        XCTAssertEqual(request.httpMethod, "POST")
        XCTAssertEqual(request.url?.path, "/api/v1/collections/4/photos")
        let body = try jsonBody(request)
        XCTAssertEqual(Set(body.keys), ["photoIds"])
        XCTAssertEqual(body["photoIds"] as? [Int], [1, 2])
        XCTAssertEqual(result, CollectionPhotosAddedDTO(added: 2, photoCount: 5))
    }

    func testRemovePhotosPostsToRemoveRoute() async throws {
        StubURLProtocol.respond(status: 200, body: #"{"removed":1,"photoCount":4}"#)
        let result = try await StubURLProtocol.makeClient().removePhotos(fromCollection: 4, photoIds: [2])

        let request = try onlyRequest()
        XCTAssertEqual(request.httpMethod, "POST")
        XCTAssertEqual(request.url?.path, "/api/v1/collections/4/photos/remove")
        XCTAssertEqual(try jsonBody(request)["photoIds"] as? [Int], [2])
        XCTAssertEqual(result, CollectionPhotosRemovedDTO(removed: 1, photoCount: 4))
    }

    func testCollectionsForPhotoIsGet() async throws {
        StubURLProtocol.respond(status: 200, body: #"{"collectionIds":[4,9]}"#)
        let result = try await StubURLProtocol.makeClient().collectionsForPhoto(id: 12)

        let request = try onlyRequest()
        XCTAssertEqual(request.httpMethod, "GET")
        XCTAssertEqual(request.url?.path, "/api/v1/photos/12/collections")
        XCTAssertEqual(result.collectionIds, [4, 9])
    }

    func testCollectionsForMissingPhotoSurfacesServerError() async {
        StubURLProtocol.respond(status: 404, body: #"{"error":{"code":"PHOTO_NOT_FOUND","message":"Photo not found"}}"#)
        await assertThrows(.server(status: 404, code: "PHOTO_NOT_FOUND", message: "Photo not found")) {
            _ = try await StubURLProtocol.makeClient().collectionsForPhoto(id: 12)
        }
    }

    func testMembershipBatchBoundsAreRejectedWithoutRequest() async {
        let client = StubURLProtocol.makeClient()
        await assertThrows(.invalidRequest) { _ = try await client.addPhotos(toCollection: 4, photoIds: []) }
        await assertThrows(.invalidRequest) {
            _ = try await client.addPhotos(toCollection: 4, photoIds: Array(1...501))
        }
        await assertThrows(.invalidRequest) { _ = try await client.removePhotos(fromCollection: 4, photoIds: [0]) }
        await assertThrows(.invalidRequest) { _ = try await client.addPhotos(toCollection: 0, photoIds: [1]) }
        XCTAssertTrue(StubURLProtocol.requests.isEmpty)
    }

    func testFiveHundredPhotoBatchIsSent() async throws {
        StubURLProtocol.respond(status: 200, body: #"{"added":500,"photoCount":500}"#)
        _ = try await StubURLProtocol.makeClient().addPhotos(toCollection: 4, photoIds: Array(1...500))
        XCTAssertEqual((try jsonBody(onlyRequest())["photoIds"] as? [Int])?.count, 500)
    }

    func testBlankNameIsRejectedWithoutRequest() async {
        let client = StubURLProtocol.makeClient()
        await assertNameError(.empty) { _ = try await client.createCollection(name: "   \n", photoIds: nil) }
        await assertNameError(.empty) { _ = try await client.renameCollection(id: 4, name: "") }
        XCTAssertTrue(StubURLProtocol.requests.isEmpty)
    }

    func testOverlongNameIsRejectedWithoutRequest() async {
        let client = StubURLProtocol.makeClient()
        let name = String(repeating: "a", count: 101)
        await assertNameError(.tooLong) { _ = try await client.createCollection(name: name, photoIds: nil) }
        await assertNameError(.tooLong) { _ = try await client.renameCollection(id: 4, name: name) }
        XCTAssertTrue(StubURLProtocol.requests.isEmpty)
    }

    func testHundredCharacterNameAfterTrimmingIsSent() async throws {
        StubURLProtocol.respond(status: 201, body: Self.collectionJSON)
        let name = String(repeating: "a", count: 100)
        _ = try await StubURLProtocol.makeClient().createCollection(name: "  \(name)  ", photoIds: nil)
        XCTAssertEqual(try jsonBody(onlyRequest())["name"] as? String, name)
    }

    func testNameValidationMessagesAreReadable() {
        XCTAssertEqual(CollectionNameError.empty.localizedDescription, "Enter a collection name.")
        XCTAssertEqual(
            CollectionNameError.tooLong.localizedDescription,
            "Collection names can be at most 100 characters."
        )
    }

    func testCollectionIDScopesPhotosQuery() async throws {
        StubURLProtocol.respond(status: 200, body: #"{"photos":[],"total":0,"rawCount":0}"#)
        _ = try await StubURLProtocol.makeClient().photos(query: PhotoQuery(collectionId: 4))

        let request = try onlyRequest()
        let items = try XCTUnwrap(URLComponents(url: XCTUnwrap(request.url), resolvingAgainstBaseURL: false)?.queryItems)
        XCTAssertEqual(items.first { $0.name == "collectionId" }?.value, "4")
    }

    func testCollectionIDScopesSearchBody() async throws {
        StubURLProtocol.respond(status: 200, body: #"{"photos":[],"total":0,"query":"beach"}"#)
        _ = try await StubURLProtocol.makeClient().search(
            query: "beach",
            limit: 20,
            filters: PhotoQuery(collectionId: 4)
        )
        XCTAssertEqual(try jsonBody(onlyRequest())["collectionId"] as? Int, 4)
    }

    func testUnscopedSearchOmitsCollectionID() async throws {
        StubURLProtocol.respond(status: 200, body: #"{"photos":[],"total":0,"query":"beach"}"#)
        _ = try await StubURLProtocol.makeClient().search(query: "beach", limit: 20, filters: PhotoQuery())
        XCTAssertNil(try jsonBody(onlyRequest())["collectionId"])
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

    private func assertNameError(
        _ expected: CollectionNameError,
        file: StaticString = #filePath,
        line: UInt = #line,
        _ operation: () async throws -> Void
    ) async {
        do {
            try await operation()
            XCTFail("Expected \(expected)", file: file, line: line)
        } catch {
            XCTAssertEqual(error as? CollectionNameError, expected, file: file, line: line)
        }
    }
}

@MainActor
final class CollectionsStoreTests: XCTestCase {
    private func loadedStore(_ collections: [CollectionDTO], members: [Int: Set<Int>] = [:]) async -> (CollectionsStore, TestAPI) {
        let api = TestAPI()
        await api.setCollections(collections, members: members)
        let store = CollectionsStore(api: api)
        await store.load()
        return (store, api)
    }

    private func requests(_ api: TestAPI, excludingList: Bool = true) async -> [TestAPI.CollectionRequest] {
        await api.recordedCollectionRequests().filter { !excludingList || $0 != .list }
    }

    func testLoadPopulatesListInServerOrder() async {
        let (store, _) = await loadedStore([
            TestModels.collection(id: 2, name: "alpha"),
            TestModels.collection(id: 1, name: "Beta"),
        ])
        XCTAssertEqual(store.loadState, .loaded)
        XCTAssertEqual(store.collections.map(\.name), ["alpha", "Beta"])
    }

    func testInitialLoadFailureIsFailedState() async {
        let api = TestAPI()
        await api.setCollectionFailure(.list, .transport("Offline"))
        let store = CollectionsStore(api: api)
        await store.load()
        XCTAssertEqual(store.loadState, .failed("Offline"))
        XCTAssertTrue(store.collections.isEmpty)
    }

    func testRefreshFailureKeepsListAndSurfacesError() async {
        let (store, api) = await loadedStore([TestModels.collection(id: 1, name: "Trips")])
        await api.setCollectionFailure(.list, .transport("Offline"))
        await store.load()
        XCTAssertEqual(store.loadState, .loaded)
        XCTAssertEqual(store.collections.map(\.id), [1])
        XCTAssertEqual(store.errorMessage, "Offline")
    }

    func testCreateInsertsInNameOrder() async {
        let (store, api) = await loadedStore([
            TestModels.collection(id: 1, name: "Alpha"),
            TestModels.collection(id: 2, name: "Gamma"),
        ])
        let created = await store.create(name: " beta ")

        XCTAssertEqual(created?.name, "beta")
        XCTAssertEqual(store.collections.map(\.name), ["Alpha", "beta", "Gamma"])
        XCTAssertNil(store.errorMessage)
        let sent = await requests(api)
        XCTAssertEqual(sent, [.create(name: "beta", photoIds: nil)])
    }

    func testCreateDuplicateLeavesListUnchangedWithReadableError() async {
        let (store, _) = await loadedStore([TestModels.collection(id: 1, name: "Trips")])
        let before = store.collections

        let created = await store.create(name: "TRIPS")

        XCTAssertNil(created)
        XCTAssertEqual(store.collections, before)
        XCTAssertEqual(store.errorMessage, "A collection with that name already exists.")
    }

    func testCreateInvalidNameSendsNoRequest() async {
        let (store, api) = await loadedStore([])
        let blank = await store.create(name: "   ")
        XCTAssertNil(blank)
        XCTAssertEqual(store.errorMessage, "Enter a collection name.")
        let long = await store.create(name: String(repeating: "x", count: 101))
        XCTAssertNil(long)
        XCTAssertEqual(store.errorMessage, "Collection names can be at most 100 characters.")
        let sent = await requests(api)
        XCTAssertEqual(sent, [])
        XCTAssertTrue(store.collections.isEmpty)
    }

    func testCreateSuccessClearsPreviousError() async {
        let (store, _) = await loadedStore([])
        _ = await store.create(name: "")
        XCTAssertNotNil(store.errorMessage)
        _ = await store.create(name: "Trips")
        XCTAssertNil(store.errorMessage)
        XCTAssertEqual(store.collections.map(\.name), ["Trips"])
    }

    func testRenameReplacesAndReorders() async {
        let (store, api) = await loadedStore([
            TestModels.collection(id: 1, name: "Alpha", photoCount: 3),
            TestModels.collection(id: 2, name: "Beta"),
        ])
        let renamed = await store.rename(id: 1, to: "Zulu")

        XCTAssertTrue(renamed)
        XCTAssertEqual(store.collections.map(\.name), ["Beta", "Zulu"])
        XCTAssertEqual(store.collection(id: 1)?.photoCount, 3)
        let sent = await requests(api)
        XCTAssertEqual(sent, [.rename(id: 1, name: "Zulu")])
    }

    func testRenameConflictLeavesListUnchanged() async {
        let (store, _) = await loadedStore([
            TestModels.collection(id: 1, name: "Alpha"),
            TestModels.collection(id: 2, name: "Beta"),
        ])
        let before = store.collections

        let renamed = await store.rename(id: 1, to: "beta")

        XCTAssertFalse(renamed)
        XCTAssertEqual(store.collections, before)
        XCTAssertEqual(store.errorMessage, "A collection with that name already exists.")
    }

    func testRenameBlankSendsNoRequest() async {
        let (store, api) = await loadedStore([TestModels.collection(id: 1, name: "Alpha")])
        let renamed = await store.rename(id: 1, to: " ")
        XCTAssertFalse(renamed)
        XCTAssertEqual(store.collections.map(\.name), ["Alpha"])
        let sent = await requests(api)
        XCTAssertEqual(sent, [])
    }

    func testDeleteRemovesCollectionOnly() async {
        let (store, api) = await loadedStore(
            [TestModels.collection(id: 1, name: "Alpha", photoCount: 2), TestModels.collection(id: 2, name: "Beta")],
            members: [1: [10, 11]]
        )
        let deleted = await store.delete(id: 1)

        XCTAssertTrue(deleted)
        XCTAssertEqual(store.collections.map(\.id), [2])
        let sent = await requests(api)
        XCTAssertEqual(sent, [.delete(id: 1)])
        let photoQueries = await api.recordedPhotoQueries()
        XCTAssertTrue(photoQueries.isEmpty, "Deleting a collection must not touch photos")
    }

    func testDeleteFailureLeavesListUnchanged() async {
        let (store, api) = await loadedStore([TestModels.collection(id: 1, name: "Alpha")])
        await api.setCollectionFailure(.delete, .transport("Offline"))
        let before = store.collections

        let deleted = await store.delete(id: 1)

        XCTAssertFalse(deleted)
        XCTAssertEqual(store.collections, before)
        XCTAssertEqual(store.errorMessage, "Offline")
    }

    func testDeleteOfVanishedCollectionRefreshesList() async throws {
        let (store, api) = await loadedStore([
            TestModels.collection(id: 1, name: "Alpha"),
            TestModels.collection(id: 2, name: "Beta"),
        ])
        await api.setCollectionFailure(.delete, TestAPI.collectionNotFound)
        await api.setCollections([TestModels.collection(id: 2, name: "Beta")])

        let deleted = await store.delete(id: 1)

        XCTAssertFalse(deleted)
        XCTAssertEqual(store.errorMessage, "This collection no longer exists.")
        try await waitUntil { store.collections.map(\.id) == [2] }
    }

    func testSlowListResponseCannotUndoConfirmedCreate() async throws {
        let (store, api) = await loadedStore([])
        await api.setCollectionDelay(.milliseconds(80))
        let staleLoad = Task { await store.load() }
        try await Task.sleep(for: .milliseconds(10))
        await api.setCollectionDelay(.zero)

        _ = await store.create(name: "Trips")
        await staleLoad.value

        XCTAssertEqual(store.collections.map(\.name), ["Trips"])
    }

    func testLargeSelectionIsSplitIntoServerSizedBatches() async throws {
        let (store, api) = await loadedStore([TestModels.collection(id: 1, name: "Alpha")])
        try await store.setMembership(Array(1...501), collectionId: 1, isMember: true)

        let adds = await requests(api).compactMap { request -> Int? in
            if case let .add(_, ids) = request { return ids.count }
            return nil
        }
        XCTAssertEqual(adds, [500, 1])
        XCTAssertEqual(store.collection(id: 1)?.photoCount, 501)
    }

    func testCreateWithPhotosSeedsMembership() async throws {
        let (store, api) = await loadedStore([])
        let created = try await store.createCollection(name: "Trips", photoIds: [7, 8])
        XCTAssertEqual(created.photoCount, 2)
        let members = await api.serverMembers(of: created.id)
        XCTAssertEqual(members, [7, 8])
        let sent = await requests(api)
        XCTAssertEqual(sent, [.create(name: "Trips", photoIds: [7, 8])])
    }
}

@MainActor
final class CollectionMembershipStoreTests: XCTestCase {
    private func makeStores(
        members: [Int: Set<Int>] = [1: [5]]
    ) async -> (CollectionMembershipStore, CollectionsStore, TestAPI) {
        let api = TestAPI()
        await api.setCollections(
            [
                TestModels.collection(id: 1, name: "Alpha", photoCount: 1),
                TestModels.collection(id: 2, name: "Beta"),
            ],
            members: members
        )
        let collections = CollectionsStore(api: api)
        let membership = CollectionMembershipStore(photoID: 5, collections: collections)
        await membership.load()
        return (membership, collections, api)
    }

    private func membershipRequests(_ api: TestAPI) async -> [TestAPI.CollectionRequest] {
        await api.recordedCollectionRequests().filter {
            switch $0 {
            case .add, .remove: true
            default: false
            }
        }
    }

    func testLoadReadsPhotoMembershipAndCollectionList() async {
        let (membership, collections, api) = await makeStores()
        XCTAssertEqual(membership.state, .loaded)
        XCTAssertEqual(membership.memberIDs, [1])
        XCTAssertEqual(collections.collections.map(\.id), [1, 2])
        let sent = await api.recordedCollectionRequests()
        XCTAssertTrue(sent.contains(.forPhoto(id: 5)))
    }

    func testLoadFailureIsFailedState() async {
        let api = TestAPI()
        await api.setCollectionFailure(.forPhoto, .server(status: 404, code: "PHOTO_NOT_FOUND", message: "Photo not found"))
        let membership = CollectionMembershipStore(photoID: 5, collections: CollectionsStore(api: api))
        await membership.load()
        XCTAssertEqual(membership.state, .failed("Photo not found"))
    }

    func testToggleOnAddsPhoto() async {
        let (membership, collections, api) = await makeStores()
        let task = membership.toggle(2)
        XCTAssertTrue(membership.isMember(2), "Toggle applies optimistically")
        XCTAssertTrue(membership.inFlightIDs.contains(2))
        await task?.value

        XCTAssertTrue(membership.isMember(2))
        XCTAssertTrue(membership.inFlightIDs.isEmpty)
        let sent = await membershipRequests(api)
        XCTAssertEqual(sent, [.add(id: 2, photoIds: [5])])
        XCTAssertEqual(collections.collection(id: 2)?.photoCount, 1)
        let members = await api.serverMembers(of: 2)
        XCTAssertEqual(members, [5])
    }

    func testToggleOffRemovesPhoto() async {
        let (membership, collections, api) = await makeStores()
        await membership.toggle(1)?.value

        XCTAssertFalse(membership.isMember(1))
        let sent = await membershipRequests(api)
        XCTAssertEqual(sent, [.remove(id: 1, photoIds: [5])])
        XCTAssertEqual(collections.collection(id: 1)?.photoCount, 0)
    }

    func testFailedAddRollsBack() async {
        let (membership, collections, api) = await makeStores()
        await api.setCollectionFailure(.add, .transport("Offline"))
        await membership.toggle(2)?.value

        XCTAssertFalse(membership.isMember(2))
        XCTAssertEqual(membership.errorMessage, "Offline")
        XCTAssertEqual(collections.collection(id: 2)?.photoCount, 0)
    }

    func testFailedRemoveRollsBack() async {
        let (membership, collections, api) = await makeStores()
        await api.setCollectionFailure(.remove, .transport("Offline"))
        await membership.toggle(1)?.value

        XCTAssertTrue(membership.isMember(1))
        XCTAssertEqual(membership.errorMessage, "Offline")
        XCTAssertEqual(collections.collection(id: 1)?.photoCount, 1)
    }

    func testRowIgnoresTogglesWhileInFlight() async {
        let (membership, _, api) = await makeStores()
        await api.setCollectionDelay(.milliseconds(50))
        let first = membership.toggle(2)
        let second = membership.toggle(2)
        XCTAssertNil(second)
        await first?.value
        let sent = await membershipRequests(api)
        XCTAssertEqual(sent, [.add(id: 2, photoIds: [5])])
    }

    func testNewCollectionContainsPhoto() async {
        let (membership, collections, api) = await makeStores()
        let created = await membership.createCollection(named: "Gamma")

        XCTAssertTrue(created)
        let gamma = try? XCTUnwrap(collections.collections.first { $0.name == "Gamma" })
        XCTAssertEqual(gamma?.photoCount, 1)
        XCTAssertTrue(membership.isMember(gamma?.id ?? -1))
        let sent = await api.recordedCollectionRequests()
        XCTAssertTrue(sent.contains(.create(name: "Gamma", photoIds: [5])))
    }

    func testNewCollectionDuplicateShowsError() async {
        let (membership, collections, _) = await makeStores()
        let created = await membership.createCollection(named: "alpha")

        XCTAssertFalse(created)
        XCTAssertEqual(membership.errorMessage, "A collection with that name already exists.")
        XCTAssertEqual(collections.collections.map(\.id), [1, 2])
    }
}

@MainActor
final class CollectionDetailStoreTests: XCTestCase {
    private func makeDetail() async -> (LibraryStore, CollectionMembershipStore, TestAPI) {
        let api = TestAPI()
        let photos = [TestModels.photo(id: 5), TestModels.photo(id: 6)]
        await api.setPhotos(PhotosResponseDTO(photos: photos, total: photos.count, rawCount: 0))
        await api.setCollections(
            [TestModels.collection(id: 3, name: "Trips", photoCount: 2)],
            members: [3: [5, 6]]
        )
        let collections = CollectionsStore(api: api)
        let detail = LibraryStore(api: api, collectionId: 3)
        collections.register(detail)
        await detail.load()
        let membership = CollectionMembershipStore(photoID: 5, collections: collections)
        await membership.load()
        return (detail, membership, api)
    }

    func testDetailListingSendsCollectionID() async {
        let (detail, _, api) = await makeDetail()
        let queries = await api.recordedPhotoQueries()
        XCTAssertEqual(queries.map(\.collectionId), [3])
        XCTAssertEqual(detail.orderedRecords.map(\.id).sorted(), [5, 6])
    }

    func testFilterChangesKeepCollectionScope() async throws {
        let (detail, _, api) = await makeDetail()
        detail.applyFilters(LibraryFilters(mediaKind: .raw))
        try await waitUntil { await api.recordedPhotoQueries().count == 2 }
        let last = await api.recordedPhotoQueries().last
        XCTAssertEqual(last?.collectionId, 3)
        XCTAssertEqual(last?.filterRaw, .raw)
    }

    func testRemovalFromSheetDropsPhotoAfterLoupeDismissal() async {
        let (detail, membership, _) = await makeDetail()
        detail.activePhotoID = 5

        await membership.toggle(3)?.value

        XCTAssertEqual(detail.orderedRecords.map(\.id).sorted(), [5, 6], "The open loupe keeps its page")
        detail.activePhotoID = nil
        XCTAssertEqual(detail.orderedRecords.map(\.id), [6])
        XCTAssertEqual(detail.records.map(\.id), [6])
        XCTAssertEqual(detail.sections.flatMap(\.photos).map(\.id), [6])
    }

    func testReAddingBeforeDismissalKeepsPhoto() async {
        let (detail, membership, _) = await makeDetail()
        detail.activePhotoID = 5

        await membership.toggle(3)?.value
        await membership.toggle(3)?.value
        detail.activePhotoID = nil

        XCTAssertEqual(detail.orderedRecords.map(\.id).sorted(), [5, 6])
    }

    func testFailedRemovalKeepsPhoto() async {
        let (detail, membership, api) = await makeDetail()
        await api.setCollectionFailure(.remove, .transport("Offline"))
        detail.activePhotoID = 5

        await membership.toggle(3)?.value
        detail.activePhotoID = nil

        XCTAssertEqual(detail.orderedRecords.map(\.id).sorted(), [5, 6])
    }

    func testRemovalWithLoupeClosedDropsImmediately() async {
        let (detail, membership, _) = await makeDetail()
        await membership.toggle(3)?.value
        XCTAssertEqual(detail.orderedRecords.map(\.id), [6])
    }

    func testRemovingLastPhotoShowsEmptyState() async throws {
        let api = TestAPI()
        await api.setPhotos(PhotosResponseDTO(photos: [TestModels.photo(id: 5)], total: 1, rawCount: 0))
        await api.setCollections([TestModels.collection(id: 3, name: "Trips", photoCount: 1)], members: [3: [5]])
        let collections = CollectionsStore(api: api)
        let detail = LibraryStore(api: api, collectionId: 3)
        collections.register(detail)
        await detail.load()

        try await collections.setMembership([5], collectionId: 3, isMember: false)

        XCTAssertEqual(detail.loadState, .empty)
    }

    func testOtherCollectionChangesAreIgnored() async throws {
        let (detail, _, api) = await makeDetail()
        await api.setCollections(
            [TestModels.collection(id: 3, name: "Trips", photoCount: 2), TestModels.collection(id: 4, name: "Other")],
            members: [3: [5, 6], 4: [5]]
        )
        let collections = CollectionsStore(api: api)
        collections.register(detail)
        try await collections.setMembership([5], collectionId: 4, isMember: false)
        XCTAssertEqual(detail.orderedRecords.map(\.id).sorted(), [5, 6])
    }

    func testUnscopedLibraryOmitsCollectionID() async {
        let api = TestAPI()
        let library = LibraryStore(api: api)
        await library.load()
        let queries = await api.recordedPhotoQueries()
        XCTAssertEqual(queries.map(\.collectionId), [nil])
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
