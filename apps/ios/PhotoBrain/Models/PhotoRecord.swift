import Foundation

struct PhotoRecord: Identifiable, Hashable, Sendable {
    let id: Int
    let path: String?
    let filename: String
    let fileSize: Int?
    let thumbnailURL: URL
    let largeThumbnailURL: URL
    let isRaw: Bool
    let rawFormat: String?
    let rawStatus: String?
    let rawError: String?
    let thumbnailStatus: String?
    let embeddingStatus: String?
    let phashStatus: String?
    let exifDate: Date?
    let modifiedDate: Date?
    let createdDate: Date?
    let thumbnailUpdatedAt: Date?
    let pixelWidth: Int
    let pixelHeight: Int
    let mimeType: String?
    let exif: PhotoEXIFDTO?

    var isConvertedRAW: Bool {
        isRaw && rawStatus == "converted"
    }

    init(
        id: Int,
        filename: String,
        thumbnailURL: URL,
        isConvertedRAW: Bool,
        exifDate: Date?,
        modifiedDate: Date?,
        createdDate: Date?,
        pixelWidth: Int,
        pixelHeight: Int,
        cameraModel: String?,
        lensModel: String?
    ) {
        self.id = id
        path = nil
        self.filename = filename
        fileSize = nil
        self.thumbnailURL = thumbnailURL
        largeThumbnailURL = thumbnailURL
        isRaw = isConvertedRAW
        rawFormat = isConvertedRAW ? thumbnailURL.pathExtension.uppercased() : nil
        rawStatus = isConvertedRAW ? "converted" : nil
        rawError = nil
        thumbnailStatus = "completed"
        embeddingStatus = "completed"
        phashStatus = "completed"
        self.exifDate = exifDate
        self.modifiedDate = modifiedDate
        self.createdDate = createdDate
        thumbnailUpdatedAt = nil
        self.pixelWidth = pixelWidth
        self.pixelHeight = pixelHeight
        mimeType = nil
        exif = nil
        self.cameraModel = cameraModel
        self.lensModel = lensModel
    }

    init(dto: PhotoDTO, apiBaseURL: URL) {
        id = dto.id
        path = dto.path
        filename = dto.name
        fileSize = dto.size
        thumbnailURL = Self.thumbnailURL(
            baseURL: apiBaseURL,
            id: dto.id,
            size: "small",
            updatedAt: dto.thumbnailUpdatedAt
        )
        largeThumbnailURL = Self.thumbnailURL(
            baseURL: apiBaseURL,
            id: dto.id,
            size: "large",
            updatedAt: dto.thumbnailUpdatedAt
        )
        isRaw = dto.isRaw ?? false
        rawFormat = dto.rawFormat
        rawStatus = dto.rawStatus
        rawError = dto.rawError
        thumbnailStatus = dto.thumbnailStatus
        embeddingStatus = dto.embeddingStatus
        phashStatus = dto.phashStatus
        exifDate = dto.exif?.capturedAt
        modifiedDate = dto.modifiedAt
        createdDate = dto.createdAt
        thumbnailUpdatedAt = dto.thumbnailUpdatedAt
        pixelWidth = dto.width ?? 0
        pixelHeight = dto.height ?? 0
        mimeType = dto.mimeType
        exif = dto.exif
        cameraModel = dto.exif?.cameraDescription
        lensModel = dto.exif?.lensDescription
    }

    // Retained as denormalized display values for the privacy-safe feasibility fixture.
    let cameraModel: String?
    let lensModel: String?

    private static func thumbnailURL(
        baseURL: URL,
        id: Int,
        size: String,
        updatedAt: Date?
    ) -> URL {
        var url = baseURL
            .appendingPathComponent("api")
            .appendingPathComponent("photos")
            .appendingPathComponent(String(id))
            .appendingPathComponent("thumbnail")
            .appendingPathComponent(size)
        if let updatedAt {
            url.append(queryItems: [
                URLQueryItem(name: "v", value: String(Int(updatedAt.timeIntervalSince1970 * 1_000))),
            ])
        }
        return url
    }
}

enum LibraryGrouping: String, CaseIterable, Identifiable, Sendable {
    case years
    case months
    case all

    var id: Self { self }
    var title: String { rawValue.capitalized }
}

enum LibrarySort: String, CaseIterable, Identifiable, Sendable {
    case captured
    case added

    var id: Self { self }
    var title: String { self == .captured ? "Date Captured" : "Recently Added" }
}

struct PhotoSection: Identifiable, Hashable, Sendable {
    struct ID: Hashable, Sendable {
        let year: Int
        let month: Int
        let discriminator: String

        init(year: Int, month: Int, discriminator: String = "months") {
            self.year = year
            self.month = month
            self.discriminator = discriminator
        }
    }

    let id: ID
    let title: String
    let photos: [PhotoRecord]
}
