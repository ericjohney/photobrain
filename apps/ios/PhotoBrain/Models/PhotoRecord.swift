import Foundation

struct PhotoRecord: Identifiable, Hashable, Codable, Sendable {
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
    let mediaType: PhotoMediaType
    /// Video length; nil for stills and unprobed videos.
    let durationMs: Int?
    /// ffprobe codec name, e.g. `hevc`; nil for stills.
    let videoCodec: String?
    /// Live Photo motion clip id of a still; nil otherwise.
    let motionVideoId: Int?
    /// `GET /api/photos/{id}/file`: the original (or a converted RAW's large preview), Range-capable.
    let fileURL: URL
    /// The motion clip's file route; nil when the still has no motion clip.
    let motionVideoURL: URL?

    var isConvertedRAW: Bool {
        isRaw && rawStatus == "converted"
    }

    var isVideo: Bool { mediaType == .video }

    /// Grid badge, e.g. `ARW`, `RAW`, or `ARW+JPG`; nil for an unpaired standard photo.
    var formatBadge: String? {
        Self.formatBadge(filename: filename, isRaw: isRaw, rawFormat: rawFormat, pairedPhotoID: pairedPhotoId, pairedFormat: pairedFormat)
    }

    /// Grid duration (videos) or LIVE (stills with a motion clip) badge; nil otherwise.
    var mediaBadge: MediaBadge? {
        MediaBadge(mediaType: mediaType, durationMs: durationMs, motionVideoID: motionVideoId)
    }

    /// VoiceOver name for grid cells, e.g. "DSC_0001.JPG, ARW plus JPG pair", "DSC_0002.ARW, RAW
    /// photo", or "IMG_0003.MOV, Video, 1 minute 5 seconds".
    var accessibilityName: String {
        let name = Self.accessibilityName(filename: filename, isRaw: isRaw, pairedPhotoID: pairedPhotoId, badge: formatBadge)
        return mediaBadge.map { "\(name), \($0.accessibilityText)" } ?? name
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
        mediaType = .photo
        durationMs = nil
        videoCodec = nil
        motionVideoId = nil
        fileURL = thumbnailURL
        motionVideoURL = nil
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
        mediaType = dto.mediaType
        durationMs = dto.durationMs
        videoCodec = dto.videoCodec
        motionVideoId = dto.motionVideoId
        fileURL = Self.fileURL(baseURL: apiBaseURL, id: dto.id)
        motionVideoURL = dto.motionVideoId.map { Self.fileURL(baseURL: apiBaseURL, id: $0) }
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

    /// `GET /api/photos/{id}/file`, a binary route outside `/api/v1`.
    static func fileURL(baseURL: URL, id: Int) -> URL {
        baseURL
            .appendingPathComponent("api")
            .appendingPathComponent("photos")
            .appendingPathComponent(String(id))
            .appendingPathComponent("file")
    }
}

enum LibraryGrouping: String, CaseIterable, Identifiable, Sendable {
    case years
    case months
    /// Moments: event days by place, other days by month.
    case days
    case all

    var id: Self { self }
    var title: String {
        switch self {
        case .years: "Years"
        case .months: "Months"
        case .days, .all: "All"
        }
    }

    /// The Photos-style segments under the grid; `.all` is used only by Recently Added.
    static let segments: [LibraryGrouping] = [.years, .months, .days]

    /// Photos' density per zoom level: whole years read best tiny, days large.
    var defaultPhoneColumns: Int {
        switch self {
        case .years: 9
        case .months: 5
        case .days, .all: 3
        }
    }
}

/// The single-choice filter in the Library's More menu, like Photos' Filter submenu.
enum LibraryQuickFilter: String, CaseIterable, Identifiable, Sendable {
    case all
    case picks
    case rated
    case photos
    case videos
    case raw
    case rejected

    var id: Self { self }

    var title: String {
        switch self {
        case .all: "All Items"
        case .picks: "Picks"
        case .rated: "Rated 4★+"
        case .photos: "Photos"
        case .videos: "Videos"
        case .raw: "RAW"
        case .rejected: "Rejected"
        }
    }

    var systemImage: String {
        switch self {
        case .all: "photo.on.rectangle"
        case .picks: "heart"
        case .rated: "star"
        case .photos: "photo"
        case .videos: "video"
        case .raw: "camera.aperture"
        case .rejected: "xmark.bin"
        }
    }

    /// The empty-state title when this filter matches nothing.
    var emptyTitle: String {
        switch self {
        case .all: "No Photos"
        case .picks: "No Picks"
        case .rated: "No Rated Photos"
        case .photos: "No Photos"
        case .videos: "No Videos"
        case .raw: "No RAW Photos"
        case .rejected: "No Rejected Photos"
        }
    }

    var filters: LibraryFilters {
        var filters = LibraryFilters()
        switch self {
        case .all: break
        case .picks: filters.flag = .pick
        case .rated: filters.minRating = 4
        case .photos: filters.mediaKind = .standard
        case .videos: filters.mediaKind = .video
        case .raw: filters.mediaKind = .raw
        case .rejected: filters.flag = .reject
        }
        return filters
    }

    /// The quick filter exactly equal to `filters`, or nil for any other combination.
    init?(matching filters: LibraryFilters) {
        guard let match = Self.allCases.first(where: { $0.filters == filters }) else { return nil }
        self = match
    }
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
    var items: [LibraryEntry]
    /// Secondary header text, e.g. `Thursday · 9`; `nil` shows the title alone.
    var detail: String?

    init(id: ID, title: String, items: [LibraryEntry], detail: String? = nil) {
        self.id = id
        self.title = title
        self.items = items
        self.detail = detail
    }

    init(id: ID, title: String, photos: [PhotoRecord], detail: String? = nil) {
        self.init(id: id, title: title, items: photos.map(LibraryEntry.init(remote:)), detail: detail)
    }

    /// The section's server photos (device-only cells omitted).
    var photos: [PhotoRecord] { items.compactMap(\.remote) }
}
