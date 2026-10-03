import XCTest
@testable import PhotoBrain

final class PhotoIDAnchorTests: XCTestCase {
    func testPreservesStableIdentifierAcrossInsertionAndReordering() {
        XCTAssertEqual(
            PhotoIDAnchor.resolve(
                previousID: 30,
                previousOrderedIDs: [10, 20, 30, 40],
                nextOrderedIDs: [5, 30, 10, 20, 40]
            ),
            30
        )
    }

    func testRemovedIdentifierFallsBackToSameOrdinalPosition() {
        XCTAssertEqual(
            PhotoIDAnchor.resolve(
                previousID: 30,
                previousOrderedIDs: [10, 20, 30, 40],
                nextOrderedIDs: [10, 20, 40]
            ),
            40
        )
    }

    func testEmptyAndMissingAnchorsHaveDeterministicFallbacks() {
        XCTAssertNil(PhotoIDAnchor.resolve(previousID: 2, previousOrderedIDs: [1, 2], nextOrderedIDs: []))
        XCTAssertEqual(PhotoIDAnchor.resolve(previousID: 99, previousOrderedIDs: [1, 2], nextOrderedIDs: [7, 8]), 7)
        XCTAssertEqual(PhotoIDAnchor.resolve(previousID: nil, previousOrderedIDs: [], nextOrderedIDs: [7, 8]), 7)
    }
}
