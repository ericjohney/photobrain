import UIKit
import XCTest
@testable import PhotoBrain

@MainActor
final class LoupeStateTests: XCTestCase {
    func testZoomRangeIsOneThroughFiveAndResetRestoresPagingScale() {
        let zoom = ZoomingImageScrollView()
        XCTAssertEqual(zoom.minimumZoomScale, 1)
        XCTAssertEqual(zoom.maximumZoomScale, 5)
        zoom.setZoomScale(3, animated: false)
        zoom.resetZoom()
        XCTAssertEqual(zoom.zoomScale, 1)
    }

    func testMemoryWarningDuringSwipePreservesDestinationAndReloadsEvictedPageOnDisplay() {
        let records = RedactedFixture.make(count: 3)
        let loader = RedirectAwareImageLoader()
        let active = makeCell(photo: records[0], loader: loader)
        let destination = makeCell(photo: records[1], loader: loader)
        let offscreen = makeCell(photo: records[2], loader: loader)

        active.handleMemoryWarning(isVisible: false, activeID: records[0].id)
        destination.handleMemoryWarning(isVisible: true, activeID: records[0].id)
        offscreen.handleMemoryWarning(isVisible: false, activeID: records[0].id)

        XCTAssertTrue(active.zoomView.hasImage)
        XCTAssertTrue(destination.zoomView.hasImage)
        XCTAssertFalse(offscreen.zoomView.hasImage)

        let controller = PagedLoupeViewController()
        let collectionView = UICollectionView(
            frame: .zero,
            collectionViewLayout: UICollectionViewFlowLayout()
        )
        controller.collectionView(
            collectionView,
            willDisplay: offscreen,
            forItemAt: IndexPath(item: 2, section: 0)
        )

        XCTAssertEqual(offscreen.representedID, records[2].id)
        XCTAssertTrue(offscreen.zoomView.hasImage)
    }

    func testIDAnchorPreservesCurrentPhotoAcrossResultReplacement() {
        XCTAssertEqual(
            PhotoIDAnchor.resolve(
                previousID: 20,
                previousOrderedIDs: [10, 20, 30],
                nextOrderedIDs: [5, 20, 40]
            ),
            20
        )
    }

    func testControllerPublishesReplacementAndEmptyState() {
        let controller = PagedLoupeViewController()
        let records = RedactedFixture.make(count: 3)
        var publishedID: Int?
        var becameEmpty = false
        controller.onActiveIDChanged = { publishedID = $0 }
        controller.onEmpty = { becameEmpty = true }

        controller.update(records: records, activeID: 2)
        controller.update(records: [records[0], records[2]], activeID: 2)
        XCTAssertEqual(publishedID, 3)

        controller.update(records: [], activeID: 3)
        XCTAssertTrue(becameEmpty)
    }

    private func makeCell(photo: PhotoRecord, loader: RedirectAwareImageLoader) -> ZoomPageCell {
        let cell = ZoomPageCell(frame: CGRect(x: 0, y: 0, width: 320, height: 480))
        cell.configure(photo: photo, loader: loader, onTap: {}, onZoomChanged: { _ in })
        return cell
    }
}
