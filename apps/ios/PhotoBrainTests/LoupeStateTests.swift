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

    func testZoomPublishesOnlyStateChangesAndRestoresPagingAtFit() throws {
        let controller = PagedLoupeViewController()
        controller.loadViewIfNeeded()
        controller.view.frame = CGRect(x: 0, y: 0, width: 400, height: 800)
        controller.update(records: RedactedFixture.make(count: 3).map(LibraryEntry.init(remote:)), activeID: .remote(1))
        controller.view.layoutIfNeeded()
        let pager = try XCTUnwrap(controller.view.subviews.compactMap { $0 as? UICollectionView }.first)
        let cell = try XCTUnwrap(pager.visibleCells.compactMap { $0 as? ZoomPageCell }.first)
        cell.zoomView.setImage(UIGraphicsImageRenderer(size: CGSize(width: 400, height: 800)).image { _ in })
        var changes: [Bool] = []
        controller.onZoomChanged = { changes.append($0) }

        cell.zoomView.setZoomScale(2, animated: false)
        cell.zoomView.setZoomScale(3, animated: false)
        XCTAssertTrue(controller.isZoomed)
        XCTAssertFalse(pager.isScrollEnabled)
        XCTAssertEqual(changes, [true], "Pinch updates must not repeatedly animate the chrome")

        cell.zoomView.resetZoom()
        XCTAssertFalse(controller.isZoomed)
        XCTAssertTrue(pager.isScrollEnabled)
        XCTAssertEqual(changes, [true, false])
    }

    func testMemoryWarningDuringSwipePreservesDestinationAndReloadsEvictedPageOnDisplay() {
        let records = RedactedFixture.make(count: 3).map(LibraryEntry.init(remote:))
        let loader = RedirectAwareImageLoader()
        // The grid hands each page its decoded cell image as a placeholder.
        let active = makeCell(photo: records[0], loader: loader)
        let destination = makeCell(photo: records[1], loader: loader)
        let offscreen = makeCell(photo: records[2], loader: loader)
        let image = UIGraphicsImageRenderer(size: CGSize(width: 4, height: 4)).image { _ in }
        for cell in [active, destination, offscreen] {
            cell.zoomView.setImage(image)
        }

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

        // The evicted page is reloading (fixture URLs never resolve, so it stays empty).
        XCTAssertEqual(offscreen.representedID, records[2].id)
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
        let records = RedactedFixture.make(count: 3).map(LibraryEntry.init(remote:))
        var publishedID: LibraryEntryID?
        var becameEmpty = false
        controller.onActiveIDChanged = { publishedID = $0 }
        controller.onEmpty = { becameEmpty = true }

        controller.update(records: records, activeID: .remote(2))
        controller.update(records: [records[0], records[2]], activeID: .remote(2))
        XCTAssertEqual(publishedID, .remote(3))

        controller.update(records: [], activeID: .remote(3))
        XCTAssertTrue(becameEmpty)
    }

    func testTabletWindowResizeKeepsTheActivePageCentered() throws {
        let controller = PagedLoupeViewController()
        controller.loadViewIfNeeded()
        controller.view.frame = CGRect(x: 0, y: 0, width: 820, height: 1_180)
        controller.update(records: RedactedFixture.make(count: 10).map(LibraryEntry.init(remote:)), activeID: .remote(6))
        controller.view.layoutIfNeeded()
        let pager = try XCTUnwrap(controller.view.subviews.compactMap { $0 as? UICollectionView }.first)
        XCTAssertEqual(pager.contentOffset.x, 5 * 820, accuracy: 1)

        // A wider window makes the active page partly visible at the old offset.
        // It still needs to be centered, rather than leaving adjacent pages on screen.
        for width in [CGFloat(1_000), 600, 820] {
            controller.view.frame.size.width = width
            controller.view.setNeedsLayout()
            controller.view.layoutIfNeeded()
            XCTAssertEqual(pager.contentOffset.x, 5 * width, accuracy: 1)
        }
    }

    private func makeCell(photo: LibraryEntry, loader: RedirectAwareImageLoader) -> ZoomPageCell {
        let cell = ZoomPageCell(frame: CGRect(x: 0, y: 0, width: 320, height: 480))
        cell.configure(item: photo, loader: loader, onTap: {}, onZoomChanged: { _ in })
        return cell
    }

    func testFilmstripCentersEachIndexWidenedAndSnapsToNearest() {
        let geometry = FilmstripGeometry(itemHeight: 40, viewWidth: 400, count: 100)
        for index in [0, 1, 50, 99] {
            let offset = geometry.offset(forIndex: index)
            let frame = geometry.frame(forIndex: index, offset: offset)
            XCTAssertEqual(frame.width, geometry.wideWidth)
            XCTAssertEqual(frame.midX - offset, 200, accuracy: 0.5, "Index \(index) is centered")
            XCTAssertEqual(geometry.nearestIndex(forOffset: offset + geometry.unit * 0.4), index)
            XCTAssertEqual(geometry.frame(forIndex: index + 1, offset: offset).width, geometry.narrowWidth)
        }
        XCTAssertEqual(geometry.nearestIndex(forOffset: -500), 0)
        XCTAssertEqual(geometry.nearestIndex(forOffset: 1e6), 99)
    }

    func testFilmstripFramesNeverOverlapMidScroll() {
        let geometry = FilmstripGeometry(itemHeight: 40, viewWidth: 400, count: 20)
        for step in 0...40 {
            let offset = geometry.offset(forIndex: 5) + geometry.unit * CGFloat(step) / 40
            for index in 0..<19 {
                let lhs = geometry.frame(forIndex: index, offset: offset)
                let rhs = geometry.frame(forIndex: index + 1, offset: offset)
                XCTAssertGreaterThanOrEqual(rhs.minX - lhs.maxX, geometry.spacing - 0.001)
            }
            let visible = geometry.indexes(in: offset, offset + 400)!
            for index in 0..<20 where !visible.contains(index) {
                let frame = geometry.frame(forIndex: index, offset: offset)
                XCTAssertFalse(frame.intersects(CGRect(x: offset, y: 0, width: 400, height: 40)))
            }
        }
    }

    func testRecordIndexFollowsArrayChanges() {
        let index = LoupeRecordIndex()
        var records = RedactedFixture.make(count: 4).map(LibraryEntry.init(remote:))
        XCTAssertEqual(index.index(of: records[2].id, in: records), 2)
        let removed = records.remove(at: 0)
        XCTAssertNil(index.index(of: removed.id, in: records))
        XCTAssertEqual(index.index(of: records[2].id, in: records), 2)
    }
}
