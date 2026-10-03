import Foundation

enum RedactedFixture {
    static let expectedCount = 7_961

    static func make(count: Int = expectedCount) -> [PhotoRecord] {
        precondition(count >= 0)

        let start = Date(timeIntervalSince1970: 1_577_836_800) // 2020-01-01T00:00:00Z
        return (0..<count).map { offset in
            let id = offset + 1
            let captured = start.addingTimeInterval(TimeInterval(id * 10_921))
            let isConvertedRAW = id.isMultiple(of: 19)
            let fileExtension = isConvertedRAW ? "dng" : (id.isMultiple(of: 7) ? "heic" : "jpg")

            return PhotoRecord(
                id: id,
                filename: String(format: "synthetic_photo_%05d.%@", id, fileExtension),
                thumbnailURL: URL(string: "https://photos.example.invalid/api/photos/\(id)/thumbnail/medium")!,
                isConvertedRAW: isConvertedRAW,
                exifDate: id.isMultiple(of: 5) ? nil : captured,
                modifiedDate: id.isMultiple(of: 11) ? nil : captured.addingTimeInterval(37),
                createdDate: captured.addingTimeInterval(73),
                pixelWidth: 2_400 + (id % 5) * 480,
                pixelHeight: 1_600 + (id % 7) * 320,
                cameraModel: "Synthetic Camera \(id % 4 + 1)",
                lensModel: "Synthetic Lens \(id % 6 + 1)"
            )
        }
    }
}
