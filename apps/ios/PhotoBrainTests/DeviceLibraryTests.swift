import XCTest
@testable import PhotoBrain

final class FakeLocalAssetLibrary: LocalAssetLibrary, @unchecked Sendable {
    private let lock = NSLock()
    private var _assets: [LocalAsset]
    private var _canRead: Bool
    private var _observer: (@Sendable () -> Void)?

    init(assets: [LocalAsset] = [], canRead: Bool = true) {
        _assets = assets
        _canRead = canRead
    }

    var assetList: [LocalAsset] {
        get { lock.withLock { _assets } }
        set { lock.withLock { _assets = newValue } }
    }

    var readable: Bool {
        get { lock.withLock { _canRead } }
        set { lock.withLock { _canRead = newValue } }
    }

    func canRead() -> Bool { readable }
    func canRequestAccess() -> Bool { !readable }
    func requestAccess() async -> Bool { readable }
    func assets() -> [LocalAsset] { assetList }
    func startObserving(_ onChange: @escaping @Sendable () -> Void) { lock.withLock { _observer = onChange } }
    func stopObserving() { lock.withLock { _observer = nil } }
    func simulateChange() { lock.withLock { _observer }?() }
}

/// `GET /uploads/assets` over an in-memory (photoId, assetId) table, paged like the server.
actor FakeUploadedAssets: UploadedAssetsAPI {
    private(set) var rows: [(assetId: String, photoId: Int)] = []
    private(set) var requests: [String?] = []
    var pageSize = 2
    var failing = false

    func set(_ rows: [String: Int]) {
        self.rows = rows.map { ($0.key, $0.value) }
    }

    func setFailing(_ failing: Bool) { self.failing = failing }

    func uploadedAssets(deviceId: String, after: String?, limit: Int?) async throws -> UploadedAssetsResponseDTO {
        requests.append(after)
        if failing { throw PhotoBrainAPIError.invalidRequest }
        let ordered = rows.sorted { ($0.photoId, $0.assetId) < ($1.photoId, $1.assetId) }
        let remaining: [(assetId: String, photoId: Int)]
        if let after {
            let parts = after.split(separator: ":", maxSplits: 1)
            let photoID = Int(parts[0])!
            let assetID = String(parts[1])
            remaining = ordered.filter { ($0.photoId, $0.assetId) > (photoID, assetID) }
        } else {
            remaining = ordered
        }
        let page = Array(remaining.prefix(limit ?? pageSize))
        let more = remaining.count > page.count
        return UploadedAssetsResponseDTO(
            assets: page.map { .init(assetId: $0.assetId, photoId: $0.photoId) },
            nextCursor: more ? page.last.map { "\($0.photoId):\($0.assetId)" } : nil
        )
    }
}

private enum DeviceFixtures {
    static let deviceID = "0F8FAD5B-D9CB-469F-A165-70867728950E"
    static let baseURL = URL(string: "https://example.test")!

    /// `2024-05-18T10:00:00Z` plus `minutes`.
    static func asset(_ id: String, minutes: Int = 0, video: Bool = false) -> LocalAsset {
        LocalAsset(
            id: id,
            creationDate: Date(timeIntervalSince1970: 1_716_026_400 + Double(minutes * 60)),
            pixelWidth: 4_032,
            pixelHeight: 3_024,
            isVideo: video,
            durationMs: video ? 12_500 : nil
        )
    }

    static func record(_ id: Int, taken: String = "2024-05-18T09:00:00Z") -> PhotoRecord {
        PhotoRecord(dto: TestModels.photo(id: id, taken: taken), apiBaseURL: baseURL)
    }
}

final class LibraryMergeTests: XCTestCase {
    func testMappedAssetsCarryTheirServerPhotoAndAreListedOnce() {
        let merged = LibraryMerge.merge(
            remote: [DeviceFixtures.record(1), DeviceFixtures.record(2), DeviceFixtures.record(3)],
            assets: [DeviceFixtures.asset("a"), DeviceFixtures.asset("b"), DeviceFixtures.asset("c")],
            photoIDsByAsset: ["a": 2, "b": 9],
            filters: LibraryFilters(),
            includeDeviceOnly: true
        )
        XCTAssertEqual(merged.map(\.id), [.local("a"), .local("b"), .local("c"), .remote(1), .remote(3)])
        XCTAssertEqual(merged[0].remote?.id, 2, "the device asset carries its server photo")
        XCTAssertNil(merged[0].backupState, "synced cells have no backup badge")
        XCTAssertTrue(merged[1].isDeviceOnly, "mapped outside an unfiltered listing (stale or removed): still shown")
        XCTAssertTrue(merged[2].isDeviceOnly)
        XCTAssertEqual(merged[2].backupState, .notBackedUp)

        var picks = LibraryFilters()
        picks.flag = .pick
        let filtered = LibraryMerge.merge(
            remote: [DeviceFixtures.record(2)],
            assets: [DeviceFixtures.asset("a"), DeviceFixtures.asset("b")],
            photoIDsByAsset: ["a": 2, "b": 9],
            filters: picks,
            includeDeviceOnly: true
        )
        XCTAssertEqual(filtered.map(\.id), [.local("a")], "under a server filter, a photo the listing lacks was filtered out")
    }

    func testDuplicateAssetsOfOnePhotoShowTheFirstOnly() {
        let merged = LibraryMerge.merge(
            remote: [DeviceFixtures.record(1)],
            assets: [DeviceFixtures.asset("first"), DeviceFixtures.asset("copy")],
            photoIDsByAsset: ["first": 1, "copy": 1],
            filters: LibraryFilters(),
            includeDeviceOnly: true
        )
        XCTAssertEqual(merged.map(\.id), [.local("first")])
    }

    func testDeviceOnlyAssetsFollowLocallyEvaluableFiltersAndVisibility() {
        let assets = [DeviceFixtures.asset("still"), DeviceFixtures.asset("clip", video: true)]
        func ids(_ filters: LibraryFilters, includeDeviceOnly: Bool = true) -> [LibraryEntryID] {
            LibraryMerge.merge(
                remote: [],
                assets: assets,
                photoIDsByAsset: [:],
                filters: filters,
                includeDeviceOnly: includeDeviceOnly,
                backupState: { $0 == "clip" ? .uploading : .queued }
            ).map(\.id)
        }
        XCTAssertEqual(ids(LibraryFilters()), [.local("still"), .local("clip")])
        XCTAssertEqual(ids(LibraryFilters(mediaKind: .video)), [.local("clip")])
        XCTAssertEqual(ids(LibraryFilters(mediaKind: .standard)), [.local("still")])
        XCTAssertEqual(ids(LibraryFilters(mediaKind: .raw)), [], "RAW needs server metadata")
        var picks = LibraryFilters()
        picks.flag = .pick
        XCTAssertEqual(ids(picks), [], "curation filters need the server")
        XCTAssertEqual(ids(LibraryFilters(), includeDeviceOnly: false), [])
        let states = LibraryMerge.merge(
            remote: [], assets: assets, photoIDsByAsset: [:], filters: LibraryFilters(), includeDeviceOnly: true,
            backupState: { $0 == "clip" ? .uploading : .queued }
        ).map(\.backupState)
        XCTAssertEqual(states, [.queued, .uploading])
    }

    func testLocalFilterSupport() {
        let still = DeviceFixtures.asset("s")
        XCTAssertEqual(LocalFilterSupport.matches(still, filters: LibraryFilters()), true)
        XCTAssertEqual(LocalFilterSupport.matches(still, filters: LibraryFilters(mediaKind: .video)), false)
        var tagged = LibraryFilters()
        tagged.tag = "beach"
        XCTAssertNil(LocalFilterSupport.matches(still, filters: tagged))
    }

    func testDeviceOnlyEntriesUseWallClockCaptureDatesAndSortWithServerPhotos() {
        let zone = TimeZone(identifier: "Europe/Lisbon")!
        let asset = DeviceFixtures.asset("a")
        // 10:00 UTC is 11:00 in Lisbon in May (WEST), matching an EXIF wall clock of 11:00.
        XCTAssertEqual(
            asset.wallClockDate(in: zone),
            PhotoDateResolver.parseCaptureDate("2024-05-18T11:00:00Z")
        )

        let entries = [
            LibraryEntry(remote: DeviceFixtures.record(1, taken: "2024-05-18T09:00:00Z")),
            LibraryEntry(local: DeviceFixtures.asset("b", minutes: 600), remote: nil),
            LibraryEntry(remote: DeviceFixtures.record(2, taken: "2024-01-01T09:00:00Z")),
        ]
        let presentation = LibraryPresentationBuilder.build(items: entries, sort: .captured, grouping: .months)
        XCTAssertEqual(presentation.ordered.map(\.id), [.remote(2), .remote(1), .local("b")])
        XCTAssertEqual(presentation.sections.map(\.title), ["January 2024", "May 2024"])
        XCTAssertEqual(presentation.sections.map { $0.items.map(\.id) }, [[.remote(2)], [.remote(1), .local("b")]])
        XCTAssertEqual(presentation.sections[1].photos.map(\.id), [1], "photos lists server photos only")

        let added = LibraryPresentationBuilder.build(items: entries, sort: .added, grouping: .all)
        XCTAssertEqual(added.ordered.map(\.id), [.remote(1), .remote(2), .local("b")], "device-only photos have no server id and come last")
    }

    func testDeviceOnlyEntryBadgesAndLabels() {
        let video = LibraryEntry(local: DeviceFixtures.asset("v", video: true), remote: nil, backupState: .failed)
        XCTAssertEqual(video.mediaBadge, .video(durationMs: 12_500))
        XCTAssertTrue(video.isVideo)
        XCTAssertEqual(video.rating, 0)
        XCTAssertNil(video.flag)
        XCTAssertTrue(video.accessibilityName.hasPrefix("Video, "))
        XCTAssertEqual(LocalBackupState.failed.accessibilityText, "Backup failed")

        let synced = LibraryEntry(local: DeviceFixtures.asset("p"), remote: DeviceFixtures.record(7), backupState: .uploading)
        XCTAssertNil(synced.backupState, "a server photo is attached")
        XCTAssertEqual(synced.accessibilityName, synced.remote?.accessibilityName)
    }

    func testEntryIDsOrderServerPhotosFirst() {
        XCTAssertLessThan(LibraryEntryID.remote(9), .local("a"))
        XCTAssertLessThan(LibraryEntryID.remote(1), .remote(2))
        XCTAssertLessThan(LibraryEntryID.local("a"), .local("b"))
        XCTAssertEqual(LibraryEntryID.remote(4).remotePhotoID, 4)
        XCTAssertNil(LibraryEntryID.local("a").remotePhotoID)
    }

    func testAnchorWorksForEntryIDs() {
        XCTAssertEqual(
            PhotoIDAnchor.resolve(
                previousID: LibraryEntryID.local("b"),
                previousOrderedIDs: [.local("a"), .local("b"), .remote(3)],
                nextOrderedIDs: [.local("a"), .remote(3)]
            ),
            .remote(3)
        )
    }
}

final class AssetPhotoMapTests: XCTestCase {
    private var file: URL!

    override func setUp() {
        file = FileManager.default.temporaryDirectory
            .appendingPathComponent("asset-map-\(UUID().uuidString)")
            .appendingPathComponent("map.json")
    }

    override func tearDown() {
        try? FileManager.default.removeItem(at: file.deletingLastPathComponent())
    }

    func testRefreshPagesThenResumesFromTheLastSeenImport() async throws {
        let api = FakeUploadedAssets()
        await api.set(["a": 1, "b": 2, "c": 3])
        let map = AssetPhotoMap(fileURL: file, deviceId: DeviceFixtures.deviceID)

        let changed = try await map.refresh(api: api)
        XCTAssertTrue(changed)
        XCTAssertEqual(map.photoIDsByAsset, ["a": 1, "b": 2, "c": 3])
        XCTAssertEqual(map.cursor, "3:c")
        let firstRequests = await api.requests
        XCTAssertEqual(firstRequests, [nil, "2:b"])

        // A new import gets a higher photo id; only it is fetched.
        await api.set(["a": 1, "b": 2, "c": 3, "d": 4])
        let changedAgain = try await map.refresh(api: api)
        XCTAssertTrue(changedAgain)
        XCTAssertEqual(map.photoIDsByAsset["d"], 4)
        let requests = await api.requests
        XCTAssertEqual(requests.last, "3:c")

        let unchanged = try await map.refresh(api: api)
        XCTAssertFalse(unchanged)

        // Persisted across launches for the same device; dropped for another device.
        let reloaded = AssetPhotoMap(fileURL: file, deviceId: DeviceFixtures.deviceID)
        XCTAssertEqual(reloaded.photoIDsByAsset.count, 4)
        XCTAssertEqual(reloaded.cursor, "4:d")
        let other = AssetPhotoMap(fileURL: file, deviceId: "7C9E6679-7425-40DE-944B-E07FC1F90AE7")
        XCTAssertTrue(other.photoIDsByAsset.isEmpty)
    }

    func testResetDropsPhotosTheServerRemoved() async throws {
        let api = FakeUploadedAssets()
        await api.set(["a": 1, "b": 2])
        let map = AssetPhotoMap(fileURL: nil, deviceId: DeviceFixtures.deviceID)
        try await map.refresh(api: api)
        await api.set(["b": 2])
        try await map.refresh(api: api, reset: true)
        XCTAssertEqual(map.photoIDsByAsset, ["b": 2])
    }

    func testEmptyServerKeepsTheCursorEmpty() async throws {
        let api = FakeUploadedAssets()
        let map = AssetPhotoMap(fileURL: nil, deviceId: DeviceFixtures.deviceID)
        let changed = try await map.refresh(api: api)
        XCTAssertFalse(changed)
        XCTAssertNil(map.cursor)
    }
}

@MainActor
final class DeviceLibraryStoreTests: XCTestCase {
    private var defaults: UserDefaults!

    override func setUp() {
        defaults = UserDefaults(suiteName: "DeviceLibraryStoreTests-\(UUID().uuidString)")
    }

    private func makeStore(
        assets: [LocalAsset],
        uploaded: [String: Int] = [:],
        photos: [PhotoDTO],
        canRead: Bool = true
    ) async -> (LibraryStore, DeviceLibrary, FakeLocalAssetLibrary, TestAPI) {
        let (store, device, library, api, _) = await makeStoreWithUploads(
            assets: assets, uploaded: uploaded, photos: photos, canRead: canRead
        )
        return (store, device, library, api)
    }

    private func makeStoreWithUploads(
        assets: [LocalAsset],
        uploaded: [String: Int] = [:],
        photos: [PhotoDTO],
        canRead: Bool = true
    ) async -> (LibraryStore, DeviceLibrary, FakeLocalAssetLibrary, TestAPI, FakeUploadedAssets) {
        let library = FakeLocalAssetLibrary(assets: assets, canRead: canRead)
        let uploads = FakeUploadedAssets()
        await uploads.set(uploaded)
        let device = DeviceLibrary(
            library: library,
            api: uploads,
            map: AssetPhotoMap(fileURL: nil, deviceId: DeviceFixtures.deviceID),
            defaults: defaults
        )
        let api = TestAPI()
        await api.setPhotos(PhotosResponseDTO(photos: photos, total: photos.count, rawCount: 0))
        let store = LibraryStore(api: api, device: device)
        return (store, device, library, api, uploads)
    }

    func testLibraryMergesDevicePhotosOnceAndKeepsServerAccessors() async {
        let (store, _, _, _) = await makeStore(
            assets: [DeviceFixtures.asset("synced", minutes: -60), DeviceFixtures.asset("new", minutes: 30)],
            uploaded: ["synced": 1],
            photos: [TestModels.photo(id: 1, taken: "2024-05-18T09:00:00Z"), TestModels.photo(id: 2, taken: "2024-01-01T00:00:00Z")]
        )
        await store.load()

        XCTAssertEqual(store.loadState, .content)
        XCTAssertEqual(Set(store.orderedItems.map(\.id)), [.local("synced"), .local("new"), .remote(2)])
        XCTAssertEqual(store.orderedRecords.map(\.id).sorted(), [1, 2], "server photos, device-only omitted")
        XCTAssertEqual(store.deviceOnlyCount, 1)
        XCTAssertEqual(store.itemCountText, "3 Items")

        // Opening by server id resolves to the device cell showing it.
        store.activePhotoID = 1
        XCTAssertEqual(store.activeItemID, .local("synced"))
        XCTAssertEqual(store.activePhotoID, 1)
        store.activeItemID = .local("new")
        XCTAssertNil(store.activePhotoID, "a device-only page has no server photo")

        store.beginSelection()
        store.activate(.local("synced"))
        store.activate(.local("new"))
        XCTAssertEqual(store.selectedPhotoIDs, [1], "collections receive only server photos")
        XCTAssertEqual(store.headerSubtitle, "2 Selected")
    }

    func testImportKeepsTheOpenDevicePageAndAttachesItsServerPhoto() async {
        let (store, device, _, api, uploads) = await makeStoreWithUploads(
            assets: [DeviceFixtures.asset("new")],
            photos: []
        )
        await store.load()
        store.activeItemID = .local("new")
        XCTAssertEqual(store.item(.local("new"))?.isDeviceOnly, true)

        // The server imports the upload as photo 5.
        await api.setPhotos(PhotosResponseDTO(photos: [TestModels.photo(id: 5)], total: 1, rawCount: 0))
        await uploads.set(["new": 5])
        await device.refreshServerMapping(force: true)
        await store.load()

        XCTAssertEqual(store.activeItemID, .local("new"), "identity is stable across the import")
        XCTAssertEqual(store.activePhotoID, 5)
        XCTAssertEqual(store.orderedItems.map(\.id), [.local("new")], "listed once")
        XCTAssertEqual(store.item(.local("new"))?.remote?.id, 5)
    }

    func testOfflineStillShowsDevicePhotos() async {
        let (store, _, _, api) = await makeStore(assets: [DeviceFixtures.asset("a")], photos: [])
        await api.setPhotos(PhotosResponseDTO(photos: [], total: 0, rawCount: 0), failing: true)
        await store.load()
        XCTAssertEqual(store.loadState, .content)
        XCTAssertNotNil(store.refreshError)
        XCTAssertEqual(store.orderedItems.map(\.id), [.local("a")])
    }

    func testVisibilityAndUnreadablePhotos() async {
        let (store, device, library, _) = await makeStore(
            assets: [DeviceFixtures.asset("synced"), DeviceFixtures.asset("new")],
            uploaded: ["synced": 1],
            photos: [TestModels.photo(id: 1), TestModels.photo(id: 2)]
        )
        await store.load()
        XCTAssertEqual(store.orderedItems.count, 3)

        store.setVisibility(.server)
        await waitForRevision(store)
        XCTAssertEqual(Set(store.orderedItems.map(\.id)), [.local("synced"), .remote(2)])
        XCTAssertEqual(defaults.string(forKey: DeviceLibrary.visibilityKey), "server")

        store.setVisibility(.device)
        await waitForRevision(store)
        XCTAssertEqual(Set(store.orderedItems.map(\.id)), [.local("synced"), .local("new")])
        XCTAssertEqual(device.visibility, .device)

        store.setVisibility(.all)
        await store.load()
        library.readable = false
        await store.load()
        XCTAssertEqual(store.orderedItems.map(\.id).sorted(), [.remote(1), .remote(2)], "without Photos access only server photos show")
    }

    func testServerFiltersHideDeviceOnlyPhotos() async {
        let (store, _, _, _) = await makeStore(assets: [DeviceFixtures.asset("new")], photos: [TestModels.photo(id: 1)])
        await store.load()
        XCTAssertEqual(store.orderedItems.count, 2)
        var picks = LibraryFilters()
        picks.flag = .pick
        store.filters = picks
        await store.load()
        XCTAssertEqual(store.orderedItems.map(\.id), [.remote(1)])
    }

    func testScopedStoresIgnoreTheDevice() async {
        let library = FakeLocalAssetLibrary(assets: [DeviceFixtures.asset("a")])
        let device = DeviceLibrary(
            library: library,
            api: nil,
            map: AssetPhotoMap(fileURL: nil, deviceId: DeviceFixtures.deviceID),
            defaults: defaults
        )
        let api = TestAPI()
        await api.setPhotos(PhotosResponseDTO(photos: [TestModels.photo(id: 1)], total: 1, rawCount: 0))
        let store = LibraryStore(api: api, scope: .collection(3), device: device)
        XCTAssertNil(store.device)
        await store.load()
        XCTAssertEqual(store.orderedItems.map(\.id), [.remote(1)])
    }

    func testCurationPatchesTheDeviceCellShowingThePhoto() async {
        let (store, _, _, _) = await makeStore(
            assets: [DeviceFixtures.asset("synced")],
            uploaded: ["synced": 1],
            photos: [TestModels.photo(id: 1)]
        )
        await store.load()
        store.applyCuration(id: 1, curation: PhotoCuration(rating: 4, flag: .pick))
        XCTAssertEqual(store.item(.local("synced"))?.rating, 4)
        XCTAssertEqual(store.sections.flatMap(\.items).first?.flag, .pick)
        XCTAssertEqual(store.records.first?.rating, 4)
    }

    /// Visibility changes rebuild asynchronously through the device's revision.
    private func waitForRevision(_ store: LibraryStore) async {
        let start = store.presentationRevision
        for _ in 0..<100 where store.presentationRevision == start {
            try? await Task.sleep(for: .milliseconds(10))
        }
    }
}
