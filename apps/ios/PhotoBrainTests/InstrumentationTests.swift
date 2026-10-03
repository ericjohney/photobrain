import XCTest
@testable import PhotoBrain

final class InstrumentationTests: XCTestCase {
    func testTransferMeasurementIncludesRedirectTimeAndAllWireBytes() {
        let start = Date(timeIntervalSince1970: 1_000)
        let measurement = URLSessionTransferMeasurement(samples: [
            .init(
                fetchStart: start,
                responseStart: start.addingTimeInterval(0.100),
                responseEnd: start.addingTimeInterval(0.120),
                responseHeaderWireBytes: 100,
                responseBodyWireBytes: 10,
                responseBodyDecodedBytes: 10
            ),
            .init(
                fetchStart: start.addingTimeInterval(0.130),
                responseStart: start.addingTimeInterval(0.250),
                responseEnd: start.addingTimeInterval(0.500),
                responseHeaderWireBytes: 200,
                responseBodyWireBytes: 1_000,
                responseBodyDecodedBytes: 2_000
            ),
        ], taskStart: start.addingTimeInterval(-0.050))
        XCTAssertEqual(measurement.timeToFirstByteMilliseconds ?? -1, 300, accuracy: 0.001)
        XCTAssertEqual(measurement.bodyCompletionMilliseconds ?? -1, 550, accuracy: 0.001)
        XCTAssertEqual(measurement.responseHeaderWireBytes, 300)
        XCTAssertEqual(measurement.responseWireBytes, 1_310)
        XCTAssertEqual(measurement.responseBodyWireBytes, 1_010)
        XCTAssertEqual(measurement.responseBodyDecodedBytes, 2_010)
        XCTAssertEqual(measurement.transactionCount, 2)
    }

    func testImageInstrumentationIdentityRetainsCompleteVersionedURL() {
        let generation100 = ImageInstrumentationContext(
            photoID: 42,
            url: URL(string: "https://fixtures.example.invalid/api/photos/42/thumbnail/small?v=100")!
        )
        let generation101 = ImageInstrumentationContext(
            photoID: 42,
            url: URL(string: "https://fixtures.example.invalid/api/photos/42/thumbnail/small?v=101")!
        )

        XCTAssertEqual(
            generation100.versionedURL,
            "https://fixtures.example.invalid/api/photos/42/thumbnail/small?v=100"
        )
        XCTAssertNotEqual(generation100, generation101)
    }

    func testPresentationBuilderUsesOneCapturedFallbackOrderingForSections() {
        let baseURL = URL(string: "https://fixtures.example.invalid")!
        let records = [
            PhotoRecord(
                id: 3,
                filename: "fixture-3.jpg",
                thumbnailURL: baseURL.appending(path: "3?v=3"),
                isConvertedRAW: false,
                exifDate: Date(timeIntervalSince1970: 1_704_153_600),
                modifiedDate: nil,
                createdDate: nil,
                pixelWidth: 10,
                pixelHeight: 10,
                cameraModel: nil,
                lensModel: nil
            ),
            PhotoRecord(
                id: 1,
                filename: "fixture-1.jpg",
                thumbnailURL: baseURL.appending(path: "1?v=1"),
                isConvertedRAW: false,
                exifDate: nil,
                modifiedDate: Date(timeIntervalSince1970: 1_701_388_800),
                createdDate: nil,
                pixelWidth: 10,
                pixelHeight: 10,
                cameraModel: nil,
                lensModel: nil
            ),
            PhotoRecord(
                id: 2,
                filename: "fixture-2.jpg",
                thumbnailURL: baseURL.appending(path: "2?v=2"),
                isConvertedRAW: false,
                exifDate: nil,
                modifiedDate: nil,
                createdDate: Date(timeIntervalSince1970: 1_701_388_800),
                pixelWidth: 10,
                pixelHeight: 10,
                cameraModel: nil,
                lensModel: nil
            ),
        ]

        let presentation = LibraryPresentationBuilder.build(
            records: records,
            sort: .captured,
            grouping: .months
        )

        XCTAssertEqual(presentation.ordered.map(\.id), [1, 2, 3])
        XCTAssertEqual(presentation.sections.map(\.title), ["December 2023", "January 2024"])
        XCTAssertEqual(presentation.sections.map { $0.photos.map(\.id) }, [[1, 2], [3]])
    }
}
