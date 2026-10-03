import XCTest
@testable import PhotoBrain

final class DuplicatesAPITests: XCTestCase {
    override func tearDown() {
        StubURLProtocol.reset()
        super.tearDown()
    }

    func testResponseDecodesGroupsCountsCursorAndNullBurstDistance() throws {
        let json = #"{"groups":["#
            + #"{"key":"duplicate:4,9","kind":"duplicate","photos":[\#(Self.photoJSON(id: 9)),\#(Self.photoJSON(id: 4))],"#
            + #""suggestedKeeperId":9,"maxDistance":5},"#
            + #"{"key":"burst:1,2,3","kind":"burst","photos":[\#(Self.photoJSON(id: 1)),\#(Self.photoJSON(id: 2)),\#(Self.photoJSON(id: 3))],"#
            + #""suggestedKeeperId":1,"maxDistance":null}"#
            + #"],"counts":{"duplicate":7,"burst":2},"nextCursor":"50"}"#
        let response = try APIModelCoding.decoder().decode(DuplicateGroupsResponseDTO.self, from: Data(json.utf8))

        XCTAssertEqual(response.groups.map(\.key), ["duplicate:4,9", "burst:1,2,3"])
        XCTAssertEqual(response.groups.map(\.kind), [.duplicate, .burst])
        XCTAssertEqual(response.groups[0].photos.map(\.id), [9, 4])
        XCTAssertEqual(response.groups[0].suggestedKeeperId, 9)
        XCTAssertEqual(response.groups[0].maxDistance, 5)
        XCTAssertNil(response.groups[1].maxDistance)
        XCTAssertEqual(response.counts, DuplicateCountsDTO(duplicate: 7, burst: 2))
        XCTAssertEqual(response.counts.total, 9)
        XCTAssertEqual(response.nextCursor, "50")
    }

    func testUnknownGroupKindIsDroppedWithoutFailingDecode() throws {
        // The unknown group also carries a shape this client could not decode.
        let json = #"{"groups":["#
            + #"{"key":"similar:5,6","kind":"similar","photos":"opaque","score":0.9},"#
            + #"{"key":"duplicate:7,8","kind":"duplicate","photos":[\#(Self.photoJSON(id: 7)),\#(Self.photoJSON(id: 8))],"#
            + #""suggestedKeeperId":7,"maxDistance":0}"#
            + #"],"counts":{"duplicate":1,"burst":0,"similar":1},"nextCursor":null}"#
        let response = try APIModelCoding.decoder().decode(DuplicateGroupsResponseDTO.self, from: Data(json.utf8))

        XCTAssertEqual(response.groups.map(\.key), ["duplicate:7,8"])
        XCTAssertNil(response.nextCursor)
        XCTAssertEqual(response.counts, DuplicateCountsDTO(duplicate: 1, burst: 0))
    }

    func testListSendsOnlyLimitWhenKindAndCursorUnset() async throws {
        StubURLProtocol.respond(status: 200, body: Self.emptyList)
        _ = try await StubURLProtocol.makeClient().duplicateGroups(kind: nil, limit: 50, cursor: nil)

        let request = try XCTUnwrap(StubURLProtocol.requests.first)
        XCTAssertEqual(request.httpMethod, "GET")
        XCTAssertEqual(request.url?.path, "/api/v1/duplicates")
        XCTAssertEqual(try queryItems(of: request), [URLQueryItem(name: "limit", value: "50")])
    }

    func testListSendsKindAndOpaqueCursorWhenSet() async throws {
        StubURLProtocol.respond(status: 200, body: Self.emptyList)
        _ = try await StubURLProtocol.makeClient().duplicateGroups(kind: .burst, limit: 20, cursor: "40")

        let items = try queryItems(of: XCTUnwrap(StubURLProtocol.requests.first))
        XCTAssertEqual(
            Dictionary(uniqueKeysWithValues: items.map { ($0.name, $0.value) }),
            ["kind": "burst", "limit": "20", "cursor": "40"]
        )
    }

    func testListRejectsOutOfRangeLimitAndEmptyCursorWithoutNetwork() async {
        let invalid: [(Int, String?)] = [(0, nil), (201, nil), (10, "")]
        for (limit, cursor) in invalid {
            do {
                _ = try await StubURLProtocol.makeClient().duplicateGroups(kind: nil, limit: limit, cursor: cursor)
                XCTFail("Expected invalid request for limit \(limit), cursor \(String(describing: cursor))")
            } catch {
                XCTAssertEqual(error as? PhotoBrainAPIError, .invalidRequest)
            }
        }
        XCTAssertTrue(StubURLProtocol.requests.isEmpty)
    }

    func testKeepPostsKeyActionAndKeepIdsAndDecodesRejected() async throws {
        StubURLProtocol.respond(status: 200, body: #"{"rejected":[4,6]}"#)
        let response = try await StubURLProtocol.makeClient()
            .resolveDuplicateGroup(key: "duplicate:4,5,6", resolution: .keep([5]))

        let request = try XCTUnwrap(StubURLProtocol.requests.first)
        XCTAssertEqual(request.httpMethod, "POST")
        XCTAssertEqual(request.url?.path, "/api/v1/duplicates/resolve")
        let body = try XCTUnwrap(JSONSerialization.jsonObject(with: XCTUnwrap(request.httpBody)) as? [String: Any])
        XCTAssertEqual(body["key"] as? String, "duplicate:4,5,6")
        XCTAssertEqual(body["action"] as? String, "keep")
        XCTAssertEqual(body["keepIds"] as? [Int], [5])
        XCTAssertEqual(Set(body.keys), ["key", "action", "keepIds"])
        XCTAssertEqual(response.rejected, [4, 6])
    }

    func testDismissOmitsKeepIdsAndDecodesDismissedKey() async throws {
        StubURLProtocol.respond(status: 200, body: #"{"dismissed":"burst:1,2,3"}"#)
        let response = try await StubURLProtocol.makeClient()
            .resolveDuplicateGroup(key: "burst:1,2,3", resolution: .dismiss)

        let body = try XCTUnwrap(
            JSONSerialization.jsonObject(with: XCTUnwrap(StubURLProtocol.requests.first?.httpBody)) as? [String: Any]
        )
        XCTAssertEqual(body["key"] as? String, "burst:1,2,3")
        XCTAssertEqual(body["action"] as? String, "dismiss")
        XCTAssertEqual(Set(body.keys), ["key", "action"])
        XCTAssertEqual(response.dismissed, "burst:1,2,3")
        XCTAssertNil(response.rejected)
    }

    func testKeepRejectsEmptyOrNonPositiveIdsAndEmptyKeyWithoutNetwork() async {
        let invalid: [(String, DuplicateResolution)] = [
            ("duplicate:1,2", .keep([])),
            ("duplicate:1,2", .keep([0])),
            ("", .dismiss),
        ]
        for (key, resolution) in invalid {
            do {
                _ = try await StubURLProtocol.makeClient().resolveDuplicateGroup(key: key, resolution: resolution)
                XCTFail("Expected invalid request for \(key) \(resolution)")
            } catch {
                XCTAssertEqual(error as? PhotoBrainAPIError, .invalidRequest)
            }
        }
        XCTAssertTrue(StubURLProtocol.requests.isEmpty)
    }

    func testStaleGroupConflictMapsToTypedError() async {
        StubURLProtocol.respond(
            status: 409,
            body: #"{"error":{"code":"DUPLICATE_GROUP_CHANGED","message":"Group changed"}}"#
        )
        do {
            _ = try await StubURLProtocol.makeClient().resolveDuplicateGroup(key: "duplicate:1,2", resolution: .keep([1]))
            XCTFail("Expected a conflict")
        } catch {
            XCTAssertEqual(error as? PhotoBrainAPIError, .duplicateGroupChanged)
        }
    }

    func testInvalidRequestEnvelopeStaysAServerError() async {
        StubURLProtocol.respond(
            status: 400,
            body: #"{"error":{"code":"INVALID_REQUEST","message":"keepIds must be members"}}"#
        )
        do {
            _ = try await StubURLProtocol.makeClient().resolveDuplicateGroup(key: "duplicate:1,2", resolution: .keep([3]))
            XCTFail("Expected a server error")
        } catch {
            XCTAssertEqual(
                error as? PhotoBrainAPIError,
                .server(status: 400, code: "INVALID_REQUEST", message: "keepIds must be members")
            )
        }
    }

    private static let emptyList = #"{"groups":[],"counts":{"duplicate":0,"burst":0},"nextCursor":null}"#

    private static func photoJSON(id: Int) -> String {
        #"{"id":\#(id),"path":"synthetic/photo_\#(id).jpg","name":"photo_\#(id).jpg","size":1024,"#
            + #""createdAt":"2024-01-02T03:04:05.000Z","modifiedAt":"2024-01-02T03:04:06Z","#
            + #""width":4000,"height":3000,"mimeType":"image/jpeg","isRaw":false,"exif":null,"rating":0,"flag":null}"#
    }

    private func queryItems(of request: URLRequest) throws -> [URLQueryItem] {
        URLComponents(url: try XCTUnwrap(request.url), resolvingAgainstBaseURL: false)?.queryItems ?? []
    }
}

@MainActor
final class DuplicatesStoreTests: XCTestCase {
    private static let failure = PhotoBrainAPIError.server(status: 500, code: "INTERNAL", message: "Resolve failed")

    func testLoadPreselectsSuggestedKeeperAndAdoptsCounts() async {
        let api = TestAPI()
        await api.setDuplicateGroups([
            TestModels.duplicateGroup(ids: [3, 1, 2], keeper: 2),
            TestModels.duplicateGroup(.burst, ids: [7, 8, 9]),
        ])
        let store = DuplicatesStore(api: api)

        await store.load().value

        XCTAssertEqual(store.state, .loaded)
        XCTAssertEqual(store.groups.map(\.key), ["duplicate:1,2,3", "burst:7,8,9"])
        XCTAssertEqual(store.groups[0].photos.map(\.id), [2, 1, 3], "Keeper first, then id ascending")
        XCTAssertEqual(store.groups[0].keptIDs, [2])
        XCTAssertEqual(store.groups[0].rejectedIDs, [1, 3])
        XCTAssertNil(store.groups[1].maxDistance)
        XCTAssertEqual(store.counts, DuplicateCountsDTO(duplicate: 1, burst: 1))
        let requests = await api.recordedDuplicateGroupRequests()
        XCTAssertEqual(requests, [.init(kind: nil, limit: DuplicatesStore.pageSize, cursor: nil)])
    }

    func testKeepSelectionAlwaysRetainsAtLeastOnePhoto() async throws {
        let api = TestAPI()
        await api.setDuplicateGroups([TestModels.duplicateGroup(ids: [1, 2, 3], keeper: 2)])
        let store = DuplicatesStore(api: api)
        await store.load().value
        let key = "duplicate:1,2,3"

        XCTAssertFalse(store.toggleKeep(groupKey: key, photoID: 2), "The only kept photo cannot be unkept")
        XCTAssertEqual(store.group(for: key)?.keptIDs, [2])
        XCTAssertTrue(store.toggleKeep(groupKey: key, photoID: 3))
        XCTAssertEqual(store.group(for: key)?.keptIDs, [2, 3])
        XCTAssertTrue(store.toggleKeep(groupKey: key, photoID: 2))
        XCTAssertEqual(store.group(for: key)?.keptIDs, [3])
        XCTAssertFalse(store.toggleKeep(groupKey: key, photoID: 3))
        XCTAssertFalse(store.toggleKeep(groupKey: key, photoID: 99), "Non-members are ignored")
        XCTAssertEqual(store.group(for: key)?.keptIDs, [3])
        XCTAssertEqual(store.group(for: key)?.rejectedIDs, [2, 1])

        for id in [1, 2] { store.toggleKeep(groupKey: key, photoID: id) }
        XCTAssertNil(store.keepSelected(groupKey: key), "Keeping every photo rejects nothing and sends nothing")
        let requests = await api.recordedDuplicateResolveRequests()
        XCTAssertTrue(requests.isEmpty)
    }

    func testKeepRemovesGroupOptimisticallyAndSendsChosenKeepers() async {
        let api = TestAPI()
        await api.setDuplicateGroups([
            TestModels.duplicateGroup(ids: [1, 2, 3], keeper: 1),
            TestModels.duplicateGroup(.burst, ids: [4, 5, 6]),
        ])
        await api.setDuplicateResolve(delay: .milliseconds(150))
        let store = DuplicatesStore(api: api)
        await store.load().value
        store.toggleKeep(groupKey: "duplicate:1,2,3", photoID: 3)

        let task = store.keepSelected(groupKey: "duplicate:1,2,3")

        XCTAssertEqual(store.groups.map(\.key), ["burst:4,5,6"], "Removed before the server answers")
        XCTAssertEqual(store.counts, DuplicateCountsDTO(duplicate: 0, burst: 1))
        await task?.value
        XCTAssertEqual(store.groups.map(\.key), ["burst:4,5,6"])
        XCTAssertEqual(store.counts, DuplicateCountsDTO(duplicate: 0, burst: 1))
        XCTAssertNil(store.errorMessage)
        let requests = await api.recordedDuplicateResolveRequests()
        XCTAssertEqual(requests, [.init(key: "duplicate:1,2,3", resolution: .keep([1, 3]))])
        let rejected = await api.serverDuplicateRejected()
        XCTAssertEqual(rejected, [2])
    }

    func testFailedResolveRestoresGroupPositionCountsAndKeepChoice() async {
        let api = TestAPI()
        await api.setDuplicateGroups([
            TestModels.duplicateGroup(ids: [1, 2]),
            TestModels.duplicateGroup(ids: [3, 4], keeper: 4),
            TestModels.duplicateGroup(.burst, ids: [5, 6, 7]),
        ])
        await api.setDuplicateResolve(delay: .milliseconds(100), failure: Self.failure)
        let curation = PhotoCurationCenter(api: api)
        let spy = CurationSpy()
        curation.register(spy)
        let store = DuplicatesStore(api: api, curation: curation)
        await store.load().value
        let originalCounts = store.counts
        store.toggleKeep(groupKey: "duplicate:3,4", photoID: 3)

        let task = store.dismiss(groupKey: "duplicate:3,4")
        XCTAssertEqual(store.groups.map(\.key), ["duplicate:1,2", "burst:5,6,7"])
        XCTAssertEqual(store.counts.duplicate, 1)
        await task?.value

        XCTAssertEqual(store.groups.map(\.key), ["duplicate:1,2", "duplicate:3,4", "burst:5,6,7"])
        XCTAssertEqual(store.group(for: "duplicate:3,4")?.keptIDs, [4, 3], "The user's choice survives rollback")
        XCTAssertEqual(store.counts, originalCounts)
        XCTAssertEqual(store.errorMessage, "Resolve failed")
        XCTAssertNil(store.notice)

        await store.keepSelected(groupKey: "duplicate:1,2")?.value
        XCTAssertEqual(store.groups.map(\.key), ["duplicate:1,2", "duplicate:3,4", "burst:5,6,7"])
        XCTAssertTrue(spy.applied.isEmpty, "A failed keep publishes no reject flags")
        let dismissed = await api.serverDismissedDuplicateKeys()
        XCTAssertTrue(dismissed.isEmpty)
    }

    func testStaleGroupReloadsAndShowsNoticeInsteadOfRestoring() async throws {
        let api = TestAPI()
        await api.setDuplicateGroups([
            TestModels.duplicateGroup(ids: [1, 2]),
            TestModels.duplicateGroup(.burst, ids: [5, 6, 7]),
        ])
        let curation = PhotoCurationCenter(api: api)
        let spy = CurationSpy()
        curation.register(spy)
        let store = DuplicatesStore(api: api, curation: curation)
        await store.load().value
        // Another client rescanned: the group gained a member, so its key changed.
        await api.setDuplicateGroups([
            TestModels.duplicateGroup(ids: [1, 2, 3]),
            TestModels.duplicateGroup(.burst, ids: [5, 6, 7]),
        ])

        await store.keepSelected(groupKey: "duplicate:1,2")?.value

        try await waitUntil { store.groups.map(\.key) == ["duplicate:1,2,3", "burst:5,6,7"] }
        XCTAssertEqual(store.notice, PhotoBrainAPIError.duplicateGroupChanged.errorDescription)
        XCTAssertNil(store.errorMessage)
        XCTAssertEqual(store.counts, DuplicateCountsDTO(duplicate: 1, burst: 1))
        XCTAssertTrue(spy.applied.isEmpty)
        let requests = await api.recordedDuplicateGroupRequests()
        XCTAssertEqual(requests.count, 2, "Exactly one reload after the conflict")
        let rejected = await api.serverDuplicateRejected()
        XCTAssertTrue(rejected.isEmpty)
    }

    func testPaginationFollowsNextCursorAndSkipsListedGroups() async {
        let api = TestAPI()
        let groups = (0..<60).map { TestModels.duplicateGroup(ids: [$0 * 10 + 1, $0 * 10 + 2]) }
        await api.setDuplicateGroups(groups)
        let store = DuplicatesStore(api: api)

        await store.load().value
        XCTAssertEqual(store.groups.count, 50)
        XCTAssertEqual(store.nextCursor, "50")

        await store.loadMore()?.value

        XCTAssertEqual(store.groups.map(\.key), groups.map(\.key))
        XCTAssertNil(store.nextCursor)
        XCTAssertFalse(store.isLoadingMore)
        let requests = await api.recordedDuplicateGroupRequests()
        XCTAssertEqual(requests.last, .init(kind: nil, limit: DuplicatesStore.pageSize, cursor: "50"))
        XCTAssertNil(store.loadMore(), "No cursor means no further page")
    }

    func testLoadMoreAfterResolvingRefetchesSoNoGroupIsSkipped() async {
        let api = TestAPI()
        let groups = (0..<60).map { TestModels.duplicateGroup(ids: [$0 * 10 + 1, $0 * 10 + 2]) }
        await api.setDuplicateGroups(groups)
        let store = DuplicatesStore(api: api)
        await store.load().value

        await store.dismiss(groupKey: groups[0].key)?.value
        await store.keepSelected(groupKey: groups[1].key)?.value
        await store.loadMore()?.value

        XCTAssertEqual(store.groups.map(\.key), groups.dropFirst(2).map(\.key))
        XCTAssertNil(store.nextCursor)
        let requests = await api.recordedDuplicateGroupRequests()
        XCTAssertEqual(
            requests.last,
            .init(kind: nil, limit: 48 + DuplicatesStore.pageSize, cursor: nil),
            "The offset cursor moved under the removals, so the next page restarts from the top"
        )
    }

    func testSwitchingKindReloadsFirstPageWithKind() async throws {
        let api = TestAPI()
        await api.setDuplicateGroups([
            TestModels.duplicateGroup(ids: [1, 2]),
            TestModels.duplicateGroup(.burst, ids: [3, 4, 5]),
        ])
        let store = DuplicatesStore(api: api)
        await store.load().value

        store.setKind(.burst)

        XCTAssertEqual(store.state, .loading)
        XCTAssertTrue(store.groups.isEmpty)
        try await waitUntil { store.state == .loaded }
        XCTAssertEqual(store.groups.map(\.key), ["burst:3,4,5"])
        XCTAssertEqual(store.counts, DuplicateCountsDTO(duplicate: 1, burst: 1), "Counts cover both kinds")
        let requests = await api.recordedDuplicateGroupRequests()
        XCTAssertEqual(requests.last, .init(kind: .burst, limit: DuplicatesStore.pageSize, cursor: nil))
    }

    func testConfirmedRejectsPropagateToLibraryAndOtherStores() async {
        let api = TestAPI()
        await api.setPhotos(PhotosResponseDTO(
            photos: [1, 2, 3, 4].map { TestModels.photo(id: $0) },
            total: 4,
            rawCount: 0
        ))
        await api.setDuplicateGroups([TestModels.duplicateGroup(ids: [1, 2, 3], keeper: 1)])
        let curation = PhotoCurationCenter(api: api)
        let spy = CurationSpy()
        curation.register(spy)
        let library = LibraryStore(api: api, curation: curation)
        await library.load()
        let store = DuplicatesStore(api: api, curation: curation)
        await store.load().value

        await store.keepSelected(groupKey: "duplicate:1,2,3")?.value

        let flags = Dictionary(uniqueKeysWithValues: library.records.map { ($0.id, $0.flag) })
        XCTAssertEqual(flags, [1: nil, 2: .reject, 3: .reject, 4: nil])
        XCTAssertEqual(Set(spy.applied.map(\.id)), [2, 3])
        XCTAssertTrue(spy.applied.allSatisfy { $0.curation.flag == .reject })
        let patches = await api.recordedCurationRequests()
        XCTAssertTrue(patches.isEmpty, "The server already committed the rejects; nothing is re-sent")
    }

    func testKeepRejectsUnloadedPartnersHarmlesslyAndLoadedPartnersVisibly() async {
        let api = TestAPI()
        // 2's JPEG partner 12 is listed in the Library; 3's partner 13 is not loaded anywhere.
        await api.setPhotos(PhotosResponseDTO(
            photos: [1, 2, 3, 12].map { TestModels.photo(id: $0) },
            total: 4,
            rawCount: 0
        ))
        await api.setPhotoPartners([(2, 12), (3, 13)])
        await api.setDuplicateGroups([TestModels.duplicateGroup(ids: [1, 2, 3], keeper: 1)])
        let curation = PhotoCurationCenter(api: api)
        let library = LibraryStore(api: api, curation: curation)
        await library.load()
        let store = DuplicatesStore(api: api, curation: curation)
        await store.load().value

        await store.keepSelected(groupKey: "duplicate:1,2,3")?.value

        let flags = Dictionary(uniqueKeysWithValues: library.records.map { ($0.id, $0.flag) })
        XCTAssertEqual(flags, [1: nil, 2: .reject, 3: .reject, 12: .reject])
        XCTAssertNil(store.errorMessage)
        let rejected = await api.serverDuplicateRejected()
        XCTAssertEqual(rejected, [2, 3, 12, 13])
        let patches = await api.recordedCurationRequests()
        XCTAssertTrue(patches.isEmpty)
    }

    func testDismissPublishesNoCurationAndRecordsKey() async {
        let api = TestAPI()
        await api.setDuplicateGroups([TestModels.duplicateGroup(.burst, ids: [1, 2, 3])])
        let curation = PhotoCurationCenter(api: api)
        let spy = CurationSpy()
        curation.register(spy)
        let store = DuplicatesStore(api: api, curation: curation)
        await store.load().value

        await store.dismiss(groupKey: "burst:1,2,3")?.value

        XCTAssertTrue(store.isEmpty)
        XCTAssertEqual(store.counts, .zero)
        XCTAssertTrue(spy.applied.isEmpty)
        let dismissed = await api.serverDismissedDuplicateKeys()
        XCTAssertEqual(dismissed, ["burst:1,2,3"])
    }

    func testKeepReloadsWhenARejectedPhotoAlsoBelongsToAnotherListedGroup() async throws {
        let api = TestAPI()
        // Photo 2 is in both a duplicate group and a burst.
        await api.setDuplicateGroups([
            TestModels.duplicateGroup(ids: [1, 2]),
            TestModels.duplicateGroup(.burst, ids: [2, 3, 4]),
            TestModels.duplicateGroup(ids: [8, 9]),
        ])
        let store = DuplicatesStore(api: api)
        await store.load().value

        await store.keepSelected(groupKey: "duplicate:1,2")?.value

        try await waitUntil { store.groups.map(\.key) == ["duplicate:8,9"] }
        XCTAssertEqual(store.counts, DuplicateCountsDTO(duplicate: 1, burst: 0))
    }

    func testPageLoadNeverReaddsGroupWithResolveInFlight() async throws {
        let api = TestAPI()
        await api.setDuplicateGroups([
            TestModels.duplicateGroup(ids: [1, 2]),
            TestModels.duplicateGroup(ids: [3, 4]),
        ])
        await api.setDuplicateResolve(delay: .milliseconds(200))
        let store = DuplicatesStore(api: api)
        await store.load().value

        let resolve = store.dismiss(groupKey: "duplicate:1,2")
        await store.load().value

        XCTAssertEqual(store.groups.map(\.key), ["duplicate:3,4"])
        XCTAssertEqual(store.counts.duplicate, 1, "Server counts that predate the decision are not adopted")
        await resolve?.value
        try await waitUntil { await api.recordedDuplicateGroupRequests().count == 3 }
        XCTAssertEqual(store.counts.duplicate, 1)
    }

    func testCompareOpensLoupeOnGroupAndClosesWhenGroupResolves() async {
        let api = TestAPI()
        await api.setDuplicateGroups([TestModels.duplicateGroup(ids: [1, 2])])
        await api.setDuplicateResolve(delay: .milliseconds(50))
        let store = DuplicatesStore(api: api)
        await store.load().value

        store.compare(groupKey: "duplicate:1,2", photoID: 99)
        XCTAssertNil(store.comparison, "Only members can be compared")
        store.compare(groupKey: "duplicate:1,2", photoID: 2)
        XCTAssertEqual(store.comparison, .init(key: "duplicate:1,2", photoID: 2))

        let task = store.dismiss(groupKey: "duplicate:1,2")
        XCTAssertNil(store.comparison)
        await task?.value
    }

    func testRefreshCountsAdoptsServerCountsWithoutChangingList() async {
        let api = TestAPI()
        await api.setDuplicateGroups([
            TestModels.duplicateGroup(ids: [1, 2]),
            TestModels.duplicateGroup(.burst, ids: [3, 4, 5]),
            TestModels.duplicateGroup(.burst, ids: [6, 7, 8]),
        ])
        let store = DuplicatesStore(api: api)

        await store.refreshCounts()

        XCTAssertEqual(store.counts, DuplicateCountsDTO(duplicate: 1, burst: 2))
        XCTAssertEqual(store.counts.total, 3)
        XCTAssertTrue(store.groups.isEmpty)
        XCTAssertEqual(store.state, .idle)
        let requests = await api.recordedDuplicateGroupRequests()
        XCTAssertEqual(requests, [.init(kind: nil, limit: 1, cursor: nil)])
    }
}

@MainActor
private final class CurationSpy: CurationApplying {
    private(set) var applied: [(id: Int, curation: PhotoCuration)] = []

    func applyCuration(id: Int, curation: PhotoCuration) {
        applied.append((id, curation))
    }

    func applyFlag(id: Int, flag: PhotoFlag?) {
        applied.append((id, PhotoCuration(rating: 0, flag: flag)))
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
