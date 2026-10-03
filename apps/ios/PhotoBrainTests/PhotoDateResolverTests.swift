import XCTest
@testable import PhotoBrain

final class PhotoDateResolverTests: XCTestCase {
    func testDateFallbackPrefersEXIFThenModifiedThenCreated() {
        let exif = Date(timeIntervalSince1970: 300)
        let modified = Date(timeIntervalSince1970: 200)
        let created = Date(timeIntervalSince1970: 100)

        XCTAssertEqual(PhotoDateResolver.date(for: photo(id: 1, exif: exif, modified: modified, created: created)), exif)
        XCTAssertEqual(PhotoDateResolver.date(for: photo(id: 2, exif: nil, modified: modified, created: created)), modified)
        XCTAssertEqual(PhotoDateResolver.date(for: photo(id: 3, exif: nil, modified: nil, created: created)), created)
        XCTAssertEqual(PhotoDateResolver.date(for: photo(id: 4, exif: nil, modified: nil, created: nil)), .distantPast)
    }

    func testSortingUsesResolvedDateAndStableIntegerIdentityForTies() {
        let date = Date(timeIntervalSince1970: 1_000)
        let later = Date(timeIntervalSince1970: 2_000)
        let photos = [
            photo(id: 9, exif: later),
            photo(id: 7, exif: date),
            photo(id: 3, exif: nil, modified: date),
        ]

        XCTAssertEqual(PhotoDateResolver.sorted(photos).map(\.id), [3, 7, 9])
    }

    func testGroupingUsesResolvedDateInUTCAndKeepsChronologicalOrder() {
        let january = Date(timeIntervalSince1970: 1_704_067_200)
        let february = Date(timeIntervalSince1970: 1_706_745_600)
        let sections = PhotoDateResolver.grouped([
            photo(id: 2, exif: nil, modified: february),
            photo(id: 1, exif: january),
        ])

        XCTAssertEqual(sections.map(\.id), [
            PhotoSection.ID(year: 2024, month: 1),
            PhotoSection.ID(year: 2024, month: 2),
        ])
        XCTAssertEqual(sections.flatMap(\.photos).map(\.id), [1, 2])
    }

    func testColonSeparatedEXIFTimestampFlowsFromDTOIntoPhotoRecord() throws {
        let dto = TestModels.photo(id: 42, taken: "2024:08:12 10:30:00")
        let record = PhotoRecord(
            dto: dto,
            apiBaseURL: URL(string: "https://photos.example.invalid")!
        )
        let captured = try XCTUnwrap(record.exifDate)
        XCTAssertEqual(
            PhotoDateResolver.calendar.dateComponents(
                [.year, .month, .day, .hour, .minute, .second],
                from: captured
            ),
            DateComponents(year: 2024, month: 8, day: 12, hour: 10, minute: 30, second: 0)
        )
        XCTAssertEqual(PhotoDateResolver.date(for: record), captured)
    }

    private func photo(
        id: Int,
        exif: Date? = nil,
        modified: Date? = nil,
        created: Date? = nil
    ) -> PhotoRecord {
        PhotoRecord(
            id: id,
            filename: "synthetic_photo_\(id).jpg",
            thumbnailURL: URL(string: "https://photos.example.invalid/api/photos/\(id)/thumbnail/medium")!,
            isConvertedRAW: false,
            exifDate: exif,
            modifiedDate: modified,
            createdDate: created,
            pixelWidth: 100,
            pixelHeight: 100,
            cameraModel: "Synthetic Camera",
            lensModel: "Synthetic Lens"
        )
    }
}
