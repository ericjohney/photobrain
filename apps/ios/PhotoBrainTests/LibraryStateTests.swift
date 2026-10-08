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


    func testMomentsNameEventDaysAndGroupOtherDaysByMonth() {
        let photos = [
            TestModels.photo(id: 1, taken: "2024-05-02T10:00:00Z"),
            TestModels.photo(id: 2, taken: "2024-05-18T10:00:00Z"),
            TestModels.photo(id: 3, taken: "2024-05-18T11:00:00Z"),
            TestModels.photo(id: 4, taken: "2024-05-25T09:00:00Z"),
        ].map { PhotoRecord(dto: $0, apiBaseURL: URL(string: "https://example.test")!) }
        let presentation = LibraryPresentationBuilder.build(
            records: photos,
            sort: .captured,
            grouping: .days,
            eventTitles: ["2024-05-18": "Lisbon, Portugal"]
        )
        XCTAssertEqual(presentation.sections.map(\.title), ["May 2024", "Lisbon, Portugal", "May 2024"])
        XCTAssertEqual(presentation.sections.map { $0.photos.map(\.id) }, [[1], [2, 3], [4]])
        XCTAssertEqual(presentation.sections[1].detail, "May 18, 2024 · 2")
        XCTAssertEqual(Set(presentation.sections.map(\.id)).count, 3, "section IDs stay unique")
    }

    func testEventDayIndexCoversMultiDayEventsWithPlacesOnly() {
        let cover = CollectionCoverDTO(photoId: 1, thumbnailUpdatedAt: nil)
        let events = [
            EventDTO(id: 1, startAt: "2024-05-17T20:00:00", endAt: "2024-05-19T09:00:00", photoCount: 6, cover: cover,
                     place: EventPlaceDTO(city: "Lisbon", region: nil, country: "Portugal", countryCode: "PT")),
            EventDTO(id: 2, startAt: "2024-06-01T10:00:00", endAt: "2024-06-01T12:00:00", photoCount: 8, cover: cover, place: nil),
        ]
        XCTAssertEqual(EventDayIndex.titles(for: events), [
            "2024-05-17": "Lisbon, Portugal",
            "2024-05-18": "Lisbon, Portugal",
            "2024-05-19": "Lisbon, Portugal",
        ])
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
