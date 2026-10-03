import XCTest
@testable import PhotoBrain

@MainActor
final class LibraryStateTests: XCTestCase {
    func testFilterSummaryOrderAndMonthFormattingAreExact() {
        let filters = LibraryFilters(
            mediaKind: .raw,
            camera: "Synthetic Camera",
            lens: "Synthetic Lens",
            iso: 400,
            dateMonth: "2024-08"
        )
        XCTAssertEqual(filters.summary, "RAW, Synthetic Camera, Synthetic Lens, ISO 400, August 2024")
        XCTAssertEqual(LibraryFilters().summary, "All Items")
    }
    func testAllItemsSelectionClearsMediaAndMetadataFilters() {
        let filters = LibraryFilters(
            mediaKind: .raw,
            camera: "Synthetic Camera",
            lens: "Synthetic Lens",
            iso: 400,
            dateMonth: "2024-08"
        )
        var metadataOnly = filters
        metadataOnly.mediaKind = .all

        XCTAssertNil(metadataOnly.mediaPickerSelection)
        XCTAssertEqual(filters.selectingMediaKind(.all), LibraryFilters())
        XCTAssertEqual(metadataOnly.selectingMediaKind(.all), LibraryFilters())
    }


    func testRecentlyAddedUsesAscendingIDsAndForcesAllGrouping() async {
        let api = TestAPI()
        await api.setPhotos(
            PhotosResponseDTO(
                photos: [TestModels.photo(id: 8), TestModels.photo(id: 2), TestModels.photo(id: 5)],
                total: 3,
                rawCount: 0
            )
        )
        let store = LibraryStore(api: api)
        await store.load()
        await store.setGrouping(.months)
        await store.setSort(.added)
        XCTAssertEqual(store.grouping, .all)
        XCTAssertEqual(store.orderedRecords.map(\.id), [2, 5, 8])
    }

    func testRefreshFailureRetainsCachedContent() async {
        let api = TestAPI()
        await api.setPhotos(PhotosResponseDTO(photos: [TestModels.photo(id: 1)], total: 1, rawCount: 0))
        let store = LibraryStore(api: api)
        await store.load()
        await api.setPhotoFailure(true)
        await store.load()
        XCTAssertEqual(store.records.map(\.id), [1])
        XCTAssertNotNil(store.refreshError)
        XCTAssertEqual(store.loadState, .content)
    }

    func testHeaderAndHistoryThresholdUseExactSelectionAndPointStates() async {
        let api = TestAPI()
        await api.setPhotos(PhotosResponseDTO(photos: [TestModels.photo(id: 1)], total: 1, rawCount: 0))
        let store = LibraryStore(api: api)
        await store.load()
        XCTAssertEqual(store.headerSubtitle, "1 Item")

        store.observeVisible(firstID: 1, distanceFromNewest: 23.9)
        XCTAssertFalse(store.isBrowsingHistory)
        store.observeVisible(firstID: 1, distanceFromNewest: 24)
        XCTAssertTrue(store.isBrowsingHistory)

        store.beginSelection()
        XCTAssertEqual(store.headerSubtitle, "Select Items")
        store.activate(1)
        XCTAssertEqual(store.headerSubtitle, "1 Selected")
    }

    func testChangingFiltersClearsSelection() async {
        let api = TestAPI()
        await api.setPhotos(PhotosResponseDTO(photos: [TestModels.photo(id: 1)], total: 1, rawCount: 0))
        let store = LibraryStore(api: api)
        await store.load()
        store.beginSelection()
        store.activate(1)

        store.applyFilters(LibraryFilters(mediaKind: .raw))

        XCTAssertFalse(store.isSelecting)
        XCTAssertTrue(store.selectedPhotoIDs.isEmpty)
    }
}
