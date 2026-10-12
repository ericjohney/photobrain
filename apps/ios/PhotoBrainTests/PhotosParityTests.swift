import XCTest
@testable import PhotoBrain

/// Photos-style library and loupe behavior: gestures, grid density, the Filter menu, and
/// Search browsing by filters alone.
@MainActor
final class PhotosParityTests: XCTestCase {
    func testDismissNeedsDistanceOrDownwardFling() {
        XCTAssertFalse(LoupeDismissGesture.shouldDismiss(translationY: 60, velocityY: 200))
        XCTAssertTrue(LoupeDismissGesture.shouldDismiss(translationY: 120, velocityY: 0))
        XCTAssertTrue(LoupeDismissGesture.shouldDismiss(translationY: 30, velocityY: 1_200))
        XCTAssertFalse(LoupeDismissGesture.shouldDismiss(translationY: -30, velocityY: 1_200))
    }

    func testSwipeUpOpensInfo() {
        XCTAssertTrue(LoupeDismissGesture.shouldShowInfo(translationY: -80, velocityY: 0))
        XCTAssertTrue(LoupeDismissGesture.shouldShowInfo(translationY: -20, velocityY: -1_000))
        XCTAssertFalse(LoupeDismissGesture.shouldShowInfo(translationY: -20, velocityY: -100))
    }

    func testDragShrinksPageToSeventyPercent() {
        XCTAssertEqual(LoupeDismissGesture.progress(translationY: 0, height: 800), 0)
        XCTAssertEqual(LoupeDismissGesture.progress(translationY: 2_000, height: 800), 1)
        XCTAssertEqual(LoupeDismissGesture.scale(progress: 1), 0.7, accuracy: 0.0001)
    }

    func testPinchStepsThroughThreeFiveNineColumns() {
        XCTAssertEqual(LibraryGridViewController.nextColumns(from: 3, pinchingIn: true), 5)
        XCTAssertEqual(LibraryGridViewController.nextColumns(from: 5, pinchingIn: true), 9)
        XCTAssertNil(LibraryGridViewController.nextColumns(from: 9, pinchingIn: true))
        XCTAssertEqual(LibraryGridViewController.nextColumns(from: 9, pinchingIn: false), 5)
        XCTAssertNil(LibraryGridViewController.nextColumns(from: 3, pinchingIn: false))
    }

    func testWideScreensScaleChosenColumns() {
        XCTAssertEqual(LibraryGridViewController.columnCount(width: 402, phoneColumns: 3), 3)
        XCTAssertEqual(LibraryGridViewController.columnCount(width: 820, phoneColumns: 5), 10)
        XCTAssertEqual(LibraryGridViewController.columnCount(width: 402, phoneColumns: nil), 4)
    }

    func testGroupingSegmentsMatchPhotos() {
        XCTAssertEqual(LibraryGrouping.segments.map(\.title), ["Years", "Months", "All Photos"])
        XCTAssertEqual(LibraryGrouping.segments.map(\.defaultPhoneColumns), [9, 5, 3])
    }

    func testQuickFiltersRoundTripAndNeverStack() {
        for filter in LibraryQuickFilter.allCases {
            XCTAssertEqual(LibraryQuickFilter(matching: filter.filters), filter)
        }
        var stacked = LibraryQuickFilter.picks.filters
        stacked.mediaKind = .video
        XCTAssertNil(LibraryQuickFilter(matching: stacked))
        XCTAssertEqual(LibraryQuickFilter.videos.filters.flag, nil)
        XCTAssertEqual(LibraryQuickFilter.all.filters, LibraryFilters())
    }

    func testSearchBrowsesFiltersWithoutQueryNewestFirst() async {
        let api = TestAPI()
        await api.setPhotos(PhotosResponseDTO(
            photos: [TestModels.photo(id: 1), TestModels.photo(id: 2)],
            total: 2,
            rawCount: 0
        ))
        let store = SearchStore(api: api)
        store.show(.gear(.camera("Sony A7 IV")))
        try? await Task.sleep(for: .milliseconds(100))

        XCTAssertTrue(store.isBrowsingFilters)
        XCTAssertEqual(store.state, .results)
        XCTAssertEqual(store.records.map(\.id), [2, 1])
        let queries = await api.recordedPhotoQueries()
        XCTAssertEqual(queries.last?.camera, "Sony A7 IV")

        store.clearFilters()
        XCTAssertEqual(store.state, .idle)
        XCTAssertTrue(store.records.isEmpty)
    }

    func testShortcutReplacesQueryAndPreviousFilters() {
        let store = SearchStore(api: TestAPI())
        store.query = "beach"
        store.applyFilters(LibraryFilters(mediaKind: .raw))
        store.show(.tag("dog"))
        XCTAssertEqual(store.query, "")
        XCTAssertEqual(store.filters.tag, "dog")
        XCTAssertEqual(store.filters.mediaKind, .all)
    }
}
