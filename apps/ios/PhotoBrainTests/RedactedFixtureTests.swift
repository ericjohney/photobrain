import XCTest
@testable import PhotoBrain

final class RedactedFixtureTests: XCTestCase {
    func testFixtureHasExactStableShape() {
        let firstRun = RedactedFixture.make()
        let secondRun = RedactedFixture.make()

        XCTAssertEqual(firstRun.count, 7_961)
        XCTAssertEqual(firstRun, secondRun)
        XCTAssertEqual(Set(firstRun.map(\.id)).count, 7_961)
        XCTAssertEqual(firstRun.map(\.id), Array(1...7_961))
    }

    func testFixtureContainsOnlySyntheticPrivacySafeMetadata() {
        let records = RedactedFixture.make()
        let filenamePattern = #"^synthetic_photo_[0-9]{5}\.(jpg|heic|dng)$"#

        for record in records {
            XCTAssertNotNil(record.filename.range(of: filenamePattern, options: .regularExpression))
            XCTAssertFalse(record.filename.hasPrefix("/"))
            XCTAssertFalse(record.filename.contains("\\"))
            XCTAssertEqual(record.thumbnailURL.scheme, "https")
            XCTAssertEqual(record.thumbnailURL.host, "photos.example.invalid")
            XCTAssertTrue(record.cameraModel?.hasPrefix("Synthetic Camera ") == true)
            XCTAssertTrue(record.lensModel?.hasPrefix("Synthetic Lens ") == true)

            let fieldNames = Mirror(reflecting: record).children.compactMap(\.label).map { $0.lowercased() }
            XCTAssertFalse(fieldNames.contains { name in
                name.contains("gps") || name.contains("latitude") || name.contains("longitude") || name.contains("location")
            })
        }
    }
}
