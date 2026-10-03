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
    /// Mutable so a single record can be patched optimistically without a reload.
    var rating: Int
    var flag: PhotoFlag?
    /// RAW+JPEG partner id and format (see `PhotoDTO`); nil when unpaired.
    let pairedPhotoId: Int?
    let pairedFormat: String?
    /// Why the photo is in the junk review; empty outside it.
    var junkReasons: [JunkReason] = []

    var isConvertedRAW: Bool {
        isRaw && rawStatus == "converted"
    }

    /// Grid badge, e.g. `ARW`, `RAW`, or `ARW+JPG`; nil for an unpaired standard photo.
    var formatBadge: String? {
        Self.formatBadge(filename: filename, isRaw: isRaw, rawFormat: rawFormat, pairedPhotoID: pairedPhotoId, pairedFormat: pairedFormat)
    }

    /// VoiceOver name for grid cells, e.g. "DSC_0001.JPG, ARW plus JPG pair" or "DSC_0002.ARW, RAW photo".
    var accessibilityName: String {
        Self.accessibilityName(filename: filename, isRaw: isRaw, pairedPhotoID: pairedPhotoId, badge: formatBadge)
    }

    /// Paired: `rawPart+stdPart`, where the RAW side is the RAW file's format (falling back to
    /// `RAW`) and the standard side is the standard file's extension. Unpaired RAW: its format
    /// or `RAW`.
    static func formatBadge(
        filename: String,
        isRaw: Bool,
        rawFormat: String?,
        pairedPhotoID: Int?,
        pairedFormat: String?
    ) -> String? {
        let ownRawFormat = rawFormat.flatMap { $0.isEmpty ? nil : $0 } ?? "RAW"
        guard pairedPhotoID != nil, let partner = pairedFormat, !partner.isEmpty else {
            return isRaw ? ownRawFormat : nil
        }
        if isRaw { return "\(ownRawFormat)+\(partner)" }
        let ownExtension = (filename as NSString).pathExtension.uppercased()
        return ownExtension.isEmpty ? partner : "\(partner)+\(ownExtension)"
    }

    static func accessibilityName(filename: String, isRaw: Bool, pairedPhotoID: Int?, badge: String?) -> String {
        if pairedPhotoID != nil, let badge, badge.contains("+") {
            return "\(filename), \(badge.replacingOccurrences(of: "+", with: " plus ")) pair"
        }
        return isRaw ? "\(filename), RAW photo" : filename
    }

    var isRejected: Bool { flag == .reject }

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
        rating = 0
        flag = nil
        self.cameraModel = cameraModel
        self.lensModel = lensModel
        pairedPhotoId = nil
        pairedFormat = nil
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
        rating = dto.rating
        flag = dto.flag
        junkReasons = dto.junkReasons
        pairedPhotoId = dto.pairedPhotoId
        pairedFormat = dto.pairedFormat
        cameraModel = dto.exif?.cameraDescription
        lensModel = dto.exif?.lensDescription
    }

    // Retained as denormalized display values for the privacy-safe feasibility fixture.
    let cameraModel: String?
    let lensModel: String?

    static func thumbnailURL(
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
    var photos: [PhotoRecord]
}
