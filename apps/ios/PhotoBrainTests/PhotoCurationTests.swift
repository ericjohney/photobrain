import XCTest
@testable import PhotoBrain

final class CurationAPITests: XCTestCase {
    override func tearDown() {
        StubURLProtocol.reset()
        super.tearDown()
    }

    func testPhotoDecodesRatingAndFlagWhenPresent() throws {
        let photo = try decodePhoto(#""rating":4,"flag":"reject""#)
        XCTAssertEqual(photo.rating, 4)
        XCTAssertEqual(photo.flag, .reject)

        let record = PhotoRecord(dto: photo, apiBaseURL: URL(string: "https://photos.example.invalid")!)
        XCTAssertEqual(record.rating, 4)
        XCTAssertEqual(record.flag, .reject)
        XCTAssertTrue(record.isRejected)
    }

    func testPhotoDecodesExplicitNullFlagAsUnflagged() throws {
        let photo = try decodePhoto(#""rating":0,"flag":null"#)
        XCTAssertEqual(photo.rating, 0)
        XCTAssertNil(photo.flag)
    }

    func testPhotoFromOlderServerWithoutCurationDecodesAsUnratedAndUnflagged() throws {
        let photo = try decodePhoto(nil)
        XCTAssertEqual(photo.rating, 0)
        XCTAssertNil(photo.flag)
        XCTAssertFalse(PhotoRecord(dto: photo, apiBaseURL: URL(string: "https://photos.example.invalid")!).isRejected)
    }

    func testUnknownFlagValueFailsDecoding() {
        XCTAssertThrowsError(try decodePhoto(#""rating":1,"flag":"maybe""#))
    }

    func testRatingOnlyPatchSendsOnlyRating() async throws {
        let (request, body) = try await sentPatch(id: 7, rating: 3, flag: nil)
        XCTAssertEqual(request.httpMethod, "PATCH")
        XCTAssertEqual(request.url?.path, "/api/v1/photos/7")
        XCTAssertEqual(request.value(forHTTPHeaderField: "Content-Type"), "application/json")
        XCTAssertEqual(Set(body.keys), ["rating"])
        XCTAssertEqual(body["rating"] as? Int, 3)
    }

    func testClearingFlagEncodesExplicitJSONNull() async throws {
        let (_, body) = try await sentPatch(id: 7, rating: nil, flag: .some(nil))
        XCTAssertEqual(Set(body.keys), ["flag"])
        XCTAssertTrue(body["flag"] is NSNull)
    }

    func testRatingZeroAndFlagAreBothSent() async throws {
        let (_, body) = try await sentPatch(id: 7, rating: 0, flag: .some(.pick))
        XCTAssertEqual(Set(body.keys), ["rating", "flag"])
        XCTAssertEqual(body["rating"] as? Int, 0)
        XCTAssertEqual(body["flag"] as? String, "pick")
    }

    func testPatchReturnsDecodedServerPhoto() async throws {
        StubURLProtocol.respond(status: 200, body: Self.photoJSON(id: 7, extra: #""rating":5,"flag":"pick""#))
        let photo = try await StubURLProtocol.makeClient().updateCuration(id: 7, rating: 5, flag: .some(.pick))
        XCTAssertEqual(photo.id, 7)
        XCTAssertEqual(photo.rating, 5)
        XCTAssertEqual(photo.flag, .pick)
    }

    func testInvalidCurationRequestsAreRejectedWithoutNetwork() async {
        let client = StubURLProtocol.makeClient()
        let cases: [(id: Int, rating: Int?, flag: PhotoFlag??)] = [
            (7, 6, nil),
            (7, -1, nil),
            (7, 6, .some(.pick)),
            (7, nil, nil),
            (0, 3, nil),
        ]
        for item in cases {
            do {
                _ = try await client.updateCuration(id: item.id, rating: item.rating, flag: item.flag)
                XCTFail("Expected invalidRequest for id \(item.id), rating \(String(describing: item.rating))")
            } catch {
                XCTAssertEqual(error as? PhotoBrainAPIError, .invalidRequest)
            }
        }
        XCTAssertTrue(StubURLProtocol.requests.isEmpty)
    }

    func testBoundaryRatingsAreAccepted() async throws {
        for rating in [0, 5] {
            StubURLProtocol.reset()
            let (_, body) = try await sentPatch(id: 1, rating: rating, flag: nil)
            XCTAssertEqual(body["rating"] as? Int, rating)
        }
    }

    func testMissingPhotoSurfacesServerEnvelope() async {
        StubURLProtocol.respond(
            status: 404,
            body: #"{"error":{"code":"PHOTO_NOT_FOUND","message":"Photo not found"}}"#
        )
        do {
            _ = try await StubURLProtocol.makeClient().updateCuration(id: 99, rating: 1, flag: nil)
            XCTFail("Expected a server error")
        } catch {
            XCTAssertEqual(
                error as? PhotoBrainAPIError,
                .server(status: 404, code: "PHOTO_NOT_FOUND", message: "Photo not found")
            )
        }
    }

    func testCurationFiltersEncodeIntoPhotosQuery() async throws {
        StubURLProtocol.respond(status: 200, body: #"{"photos":[],"total":0,"rawCount":0}"#)
        _ = try await StubURLProtocol.makeClient().photos(
            query: PhotoQuery(filterRaw: .standard, minRating: 2, flag: .pick)
        )

        let request = try XCTUnwrap(StubURLProtocol.requests.first)
        XCTAssertEqual(request.httpMethod, "GET")
        XCTAssertEqual(request.url?.path, "/api/v1/photos")
        let items = try XCTUnwrap(URLComponents(url: XCTUnwrap(request.url), resolvingAgainstBaseURL: false)?.queryItems)
        XCTAssertEqual(
            Dictionary(uniqueKeysWithValues: items.map { ($0.name, $0.value) }),
            ["filterRaw": "standard", "minRating": "2", "flag": "pick"]
        )
    }

    func testUnsetCurationFiltersAreOmittedFromPhotosQuery() async throws {
        StubURLProtocol.respond(status: 200, body: #"{"photos":[],"total":0,"rawCount":0}"#)
        _ = try await StubURLProtocol.makeClient().photos(query: PhotoQuery())

        let request = try XCTUnwrap(StubURLProtocol.requests.first)
        let items = URLComponents(url: try XCTUnwrap(request.url), resolvingAgainstBaseURL: false)?.queryItems ?? []
        XCTAssertEqual(items.map(\.name), ["filterRaw"])
    }

    func testUnflaggedFilterEncodesItsWireValue() async throws {
        StubURLProtocol.respond(status: 200, body: #"{"photos":[],"total":0,"rawCount":0}"#)
        _ = try await StubURLProtocol.makeClient().photos(query: PhotoQuery(flag: .unflagged))

        let request = try XCTUnwrap(StubURLProtocol.requests.first)
        let items = URLComponents(url: try XCTUnwrap(request.url), resolvingAgainstBaseURL: false)?.queryItems ?? []
        XCTAssertEqual(items.first { $0.name == "flag" }?.value, "unflagged")
        XCTAssertNil(items.first { $0.name == "minRating" })
    }

    private func sentPatch(id: Int, rating: Int?, flag: PhotoFlag??) async throws -> (URLRequest, [String: Any]) {
        StubURLProtocol.respond(status: 200, body: Self.photoJSON(id: id, extra: #""rating":0,"flag":null"#))
        _ = try await StubURLProtocol.makeClient().updateCuration(id: id, rating: rating, flag: flag)

        XCTAssertEqual(StubURLProtocol.requests.count, 1)
        let request = try XCTUnwrap(StubURLProtocol.requests.first)
        let data = try XCTUnwrap(request.httpBody)
        let body = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
        return (request, body)
    }

    private func decodePhoto(_ extra: String?) throws -> PhotoDTO {
        try APIModelCoding.decoder().decode(PhotoDTO.self, from: Data(Self.photoJSON(id: 7, extra: extra).utf8))
    }

    private static func photoJSON(id: Int, extra: String?) -> String {
        let base = #"{"id":\#(id),"path":"synthetic/photo.jpg","name":"photo.jpg","size":1024,"#
            + #""createdAt":"2024-01-02T03:04:05.000Z","modifiedAt":"2024-01-02T03:04:06Z","#
            + #""width":4000,"height":3000,"mimeType":"image/jpeg","isRaw":false,"exif":null"#
        return base + (extra.map { "," + $0 } ?? "") + "}"
    }
}

@MainActor
final class PhotoCurationStoreTests: XCTestCase {
    private func loadedLibrary(_ photos: [PhotoDTO], api: TestAPI) async -> LibraryStore {
        await api.setPhotos(PhotosResponseDTO(photos: photos, total: photos.count, rawCount: 0))
        let store = LibraryStore(api: api)
        await store.load()
        return store
    }

    private func record(_ id: Int, in store: LibraryStore) throws -> PhotoRecord {
        try XCTUnwrap(store.records.first { $0.id == id })
    }

    func testOptimisticUpdateAppliesImmediatelyAndSuccessKeepsValue() async throws {
        let api = TestAPI()
        await api.setCuration(delay: .milliseconds(50))
        let store = await loadedLibrary([TestModels.photo(id: 1), TestModels.photo(id: 2)], api: api)
        let revision = store.presentationRevision
        let orderedIDs = store.orderedRecords.map(\.id)

        let task = store.curation.update(try record(1, in: store), patch: CurationPatch(rating: 4, flag: .some(.pick)))

        // Visible before the PATCH settles, everywhere the grid and loupe read from.
        XCTAssertEqual(try record(1, in: store).rating, 4)
        XCTAssertEqual(try record(1, in: store).flag, .pick)
        XCTAssertEqual(store.orderedRecords.first { $0.id == 1 }?.rating, 4)
        XCTAssertEqual(store.sections.flatMap(\.photos).first { $0.id == 1 }?.flag, .pick)
        XCTAssertGreaterThan(store.presentationRevision, revision)
        XCTAssertEqual(store.orderedRecords.map(\.id), orderedIDs, "no re-sort or reload")
        XCTAssertEqual(try record(2, in: store).rating, 0, "other records untouched")

        await task?.value

        XCTAssertEqual(try record(1, in: store).rating, 4)
        XCTAssertEqual(try record(1, in: store).flag, .pick)
        XCTAssertNil(store.curation.errorMessage)
        let requests = await api.recordedCurationRequests()
        XCTAssertEqual(requests, [TestAPI.CurationRequest(id: 1, rating: 4, flag: .some(.pick))])
    }

    func testFailureRollsBackToConfirmedValuesAndSurfacesError() async throws {
        let api = TestAPI()
        await api.setCuration(failure: .server(status: 500, code: "INTERNAL", message: "Database is locked"))
        let store = await loadedLibrary([TestModels.photo(id: 1, rating: 2, flag: .reject)], api: api)

        let task = store.curation.update(try record(1, in: store), patch: CurationPatch(rating: 5, flag: .some(nil)))
        XCTAssertEqual(try record(1, in: store).rating, 5)
        XCTAssertNil(try record(1, in: store).flag)

        await task?.value

        XCTAssertEqual(try record(1, in: store).rating, 2)
        XCTAssertEqual(try record(1, in: store).flag, .reject)
        XCTAssertEqual(store.sections.flatMap(\.photos).first { $0.id == 1 }?.rating, 2)
        XCTAssertEqual(store.curation.errorMessage, "Database is locked")

        store.curation.dismissError()
        XCTAssertNil(store.curation.errorMessage)
    }

    func testNewEditClearsPreviousError() async throws {
        let api = TestAPI()
        await api.setCuration(failure: .transport("offline"))
        let store = await loadedLibrary([TestModels.photo(id: 1)], api: api)
        await store.curation.update(try record(1, in: store), patch: CurationPatch(rating: 1))?.value
        XCTAssertEqual(store.curation.errorMessage, "offline")

        await api.setCuration()
        await store.curation.update(try record(1, in: store), patch: CurationPatch(rating: 3))?.value
        XCTAssertNil(store.curation.errorMessage)
        XCTAssertEqual(try record(1, in: store).rating, 3)
    }

    func testRapidUpdatesWhileInFlightResolveToLastIntent() async throws {
        let api = TestAPI()
        await api.setCuration(delay: .milliseconds(150))
        let store = await loadedLibrary([TestModels.photo(id: 1)], api: api)

        let task = store.curation.update(try record(1, in: store), patch: CurationPatch(rating: 1))
        try await waitForRequests(1, api: api)

        // Taps made while the first PATCH is in flight coalesce into one follow-up request.
        store.curation.update(try record(1, in: store), patch: CurationPatch(rating: 2))
        store.curation.update(try record(1, in: store), patch: CurationPatch(flag: .some(.pick)))
        store.curation.update(try record(1, in: store), patch: CurationPatch(rating: 3))
        XCTAssertEqual(try record(1, in: store).rating, 3)
        XCTAssertEqual(try record(1, in: store).flag, .pick)

        await task?.value

        let requests = await api.recordedCurationRequests()
        XCTAssertEqual(requests, [
            TestAPI.CurationRequest(id: 1, rating: 1, flag: nil),
            TestAPI.CurationRequest(id: 1, rating: 3, flag: .some(.pick)),
        ])
        // The first response (rating 1) must not overwrite the newer intent at any point after settling.
        XCTAssertEqual(try record(1, in: store).rating, 3)
        XCTAssertEqual(try record(1, in: store).flag, .pick)
        let server = await api.serverCuration(id: 1)
        XCTAssertEqual(server, PhotoCuration(rating: 3, flag: .pick))
    }

    func testFailedRequestDoesNotDiscardNewerPendingIntent() async throws {
        let api = TestAPI()
        await api.setCuration(delay: .milliseconds(150), failure: .transport("offline"))
        let store = await loadedLibrary([TestModels.photo(id: 1)], api: api)

        let task = store.curation.update(try record(1, in: store), patch: CurationPatch(rating: 2))
        try await waitForRequests(1, api: api)
        store.curation.update(try record(1, in: store), patch: CurationPatch(rating: 4))
        await api.setCuration(delay: .zero)

        await task?.value

        XCTAssertEqual(try record(1, in: store).rating, 4)
        let server = await api.serverCuration(id: 1)
        XCTAssertEqual(server?.rating, 4)
    }

    func testSharedCenterUpdatesLibraryAndSearchTogether() async throws {
        let api = TestAPI()
        await api.setPhotos(PhotosResponseDTO(photos: [TestModels.photo(id: 5)], total: 1, rawCount: 0))
        await api.setSearch(query: "dog", delay: .zero, response: SearchResponseDTO(
            photos: [TestModels.photo(id: 5)],
            total: 1,
            query: "dog"
        ))
        let curation = PhotoCurationCenter(api: api)
        let library = LibraryStore(api: api, curation: curation)
        let search = SearchStore(api: api, curation: curation)
        await library.load()
        search.query = "dog"
        search.retry()
        let deadline = ContinuousClock.now + .seconds(3)
        while search.records.isEmpty, ContinuousClock.now < deadline {
            try await Task.sleep(for: .milliseconds(10))
        }

        let task = curation.update(try record(5, in: library), patch: CurationPatch(flag: .some(.reject)))
        XCTAssertEqual(search.records.first?.flag, .reject)
        XCTAssertEqual(library.records.first?.flag, .reject)
        await task?.value
        XCTAssertEqual(search.records.first?.flag, .reject)
    }

    func testReloadDuringPendingEditKeepsOptimisticValue() async throws {
        let api = TestAPI()
        await api.setCuration(delay: .milliseconds(150))
        let store = await loadedLibrary([TestModels.photo(id: 1)], api: api)

        let task = store.curation.update(try record(1, in: store), patch: CurationPatch(rating: 5))
        await store.load()
        XCTAssertEqual(try record(1, in: store).rating, 5, "server's pre-edit value must not flash back")

        await task?.value
        XCTAssertEqual(try record(1, in: store).rating, 5)
    }

    func testToggleHelpersClearWhenRepeated() {
        let current = PhotoCuration(rating: 3, flag: .pick)
        XCTAssertEqual(CurationPatch.toggledRating(3, current: current), CurationPatch(rating: 0))
        XCTAssertEqual(CurationPatch.toggledRating(5, current: current), CurationPatch(rating: 5))
        XCTAssertEqual(CurationPatch.toggledFlag(.pick, current: current), CurationPatch(flag: .some(nil)))
        XCTAssertEqual(CurationPatch.toggledFlag(.reject, current: current), CurationPatch(flag: .some(.reject)))
        XCTAssertTrue(CurationPatch().isEmpty)
        XCTAssertNil(PhotoCurationCenter(api: TestAPI()).update(
            PhotoRecord(dto: TestModels.photo(id: 1), apiBaseURL: URL(string: "https://photos.example.invalid")!),
            patch: CurationPatch()
        ))
    }

    func testCurationFiltersAreActiveSummarizedAndRemovable() {
        let filters = LibraryFilters(minRating: 3, flag: .unflagged)
        XCTAssertTrue(filters.isActive)
        XCTAssertEqual(filters.summary, "★★★+, Unflagged")
        XCTAssertEqual(filters.activeFields.map(\.field), [.minRating, .flag])
        XCTAssertNil(filters.removing(.minRating).minRating)
        XCTAssertEqual(filters.removing(.minRating).flag, .unflagged)
        XCTAssertFalse(filters.removing(.minRating).removing(.flag).isActive)
    }

    func testChangingCurationFilterReloadsLibraryWithThatQuery() async throws {
        let api = TestAPI()
        let store = await loadedLibrary([TestModels.photo(id: 1)], api: api)
        store.applyFilters(LibraryFilters(minRating: 4, flag: .pick))
        let deadline = ContinuousClock.now + .seconds(3)
        while await api.recordedPhotoQueries().last != PhotoQuery(minRating: 4, flag: .pick),
              ContinuousClock.now < deadline {
            try await Task.sleep(for: .milliseconds(10))
        }
        let last = await api.recordedPhotoQueries().last
        XCTAssertEqual(last, PhotoQuery(minRating: 4, flag: .pick))
    }

    private func waitForRequests(_ count: Int, api: TestAPI) async throws {
        let deadline = ContinuousClock.now + .seconds(3)
        while await api.recordedCurationRequests().count < count {
            guard ContinuousClock.now < deadline else {
                XCTFail("Timed out waiting for \(count) curation request(s)")
                return
            }
            try await Task.sleep(for: .milliseconds(5))
        }
    }
}

final class LibraryGridDiffTests: XCTestCase {
    private let base = URL(string: "https://photos.example.invalid")!

    private func records(_ dtos: [PhotoDTO]) -> [Int: PhotoRecord] {
        Dictionary(uniqueKeysWithValues: dtos.map { ($0.id, PhotoRecord(dto: $0, apiBaseURL: base)) })
    }

    func testRatingOnlyChangeMarksJustThatCellForReconfigure() {
        let previous = records([TestModels.photo(id: 1), TestModels.photo(id: 2), TestModels.photo(id: 3)])
        let next = records([TestModels.photo(id: 1), TestModels.photo(id: 2, rating: 4), TestModels.photo(id: 3)])
        XCTAssertEqual(LibraryGridDiff.reconfigureIDs(previous: previous, next: next, changedSelectionIDs: []), [2])
    }

    func testFlagOnlyChangeMarksCellForReconfigure() {
        let previous = records([TestModels.photo(id: 1, flag: .pick)])
        let next = records([TestModels.photo(id: 1, flag: .reject)])
        XCTAssertEqual(LibraryGridDiff.reconfigureIDs(previous: previous, next: next, changedSelectionIDs: []), [1])
        XCTAssertEqual(
            LibraryGridDiff.reconfigureIDs(previous: next, next: records([TestModels.photo(id: 1)]), changedSelectionIDs: []),
            [1]
        )
    }

    func testIdenticalContentReconfiguresNothing() {
        let same = records([TestModels.photo(id: 1, rating: 3, flag: .pick), TestModels.photo(id: 2)])
        XCTAssertEqual(LibraryGridDiff.reconfigureIDs(previous: same, next: same, changedSelectionIDs: []), [])
    }

    func testInsertedItemsAreNotReconfiguredButSelectionChangesAre() {
        let previous = records([TestModels.photo(id: 1)])
        let next = records([TestModels.photo(id: 1), TestModels.photo(id: 2, rating: 5)])
        XCTAssertEqual(
            LibraryGridDiff.reconfigureIDs(previous: previous, next: next, changedSelectionIDs: [1, 9]),
            [1],
            "new item 2 is configured on insertion; removed id 9 is ignored"
        )
    }

    @MainActor
    func testStoreCurationEditProducesRatingOnlyDiffForGrid() async throws {
        let api = TestAPI()
        await api.setPhotos(PhotosResponseDTO(
            photos: [TestModels.photo(id: 1), TestModels.photo(id: 2)],
            total: 2,
            rawCount: 0
        ))
        let store = LibraryStore(api: api)
        await store.load()
        let before = Dictionary(uniqueKeysWithValues: store.sections.flatMap(\.photos).map { ($0.id, $0) })
        let sectionIDs = store.sections.map(\.id)

        let target = try XCTUnwrap(store.records.first { $0.id == 2 })
        let task = store.curation.update(target, patch: CurationPatch(rating: 2))
        let after = Dictionary(uniqueKeysWithValues: store.sections.flatMap(\.photos).map { ($0.id, $0) })

        XCTAssertEqual(store.sections.map(\.id), sectionIDs, "layout unchanged")
        XCTAssertEqual(LibraryGridDiff.reconfigureIDs(previous: before, next: after, changedSelectionIDs: []), [2])
        await task?.value
    }

    func testBadgeTextAndAccessibility() {
        XCTAssertNil(CurationBadgeText.stars(0))
        XCTAssertEqual(CurationBadgeText.stars(3), "★3")
        XCTAssertEqual(CurationBadgeText.accessibilitySuffix(rating: 0, flag: nil), "")
        XCTAssertEqual(CurationBadgeText.accessibilitySuffix(rating: 1, flag: .pick), ", 1 star, Pick")
        XCTAssertEqual(CurationBadgeText.accessibilitySuffix(rating: 5, flag: .reject), ", 5 stars, Rejected")
    }
}
