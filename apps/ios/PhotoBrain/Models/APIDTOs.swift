import Foundation

enum APIModelCoding {
    static func decoder() -> JSONDecoder {
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .custom { decoder in
            let container = try decoder.singleValueContainer()
            let value = try container.decode(String.self)
            if let date = fractional.date(from: value) ?? internet.date(from: value) {
                return date
            }
            throw DecodingError.dataCorruptedError(
                in: container,
                debugDescription: "Expected an ISO 8601 date"
            )
        }
        return decoder
    }

    static func encoder() -> JSONEncoder {
        let encoder = JSONEncoder()
        encoder.dateEncodingStrategy = .iso8601
        return encoder
    }

    private static let fractional: ISO8601DateFormatter = {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter
    }()

    private static let internet = ISO8601DateFormatter()
}

struct FolderNodeDTO: Codable, Hashable, Identifiable, Sendable {
    var id: String { path }
    let name: String
    let path: String
    let photoCount: Int
    let children: [FolderNodeDTO]
}

struct FoldersResponseDTO: Codable, Equatable, Sendable {
    let folders: [FolderNodeDTO]
    let totalPhotos: Int
}

struct FilterOptionsDTO: Codable, Equatable, Sendable {
    let cameras: [String]
    let lenses: [String]
    let isos: [Int]
    let dates: [String]
    /// Auto tags present in scope, sorted by count descending then tag. Servers that predate
    /// auto tagging omit the key, which decodes as no tags.
    let tags: [TagCountDTO]
    /// Countries of photos with a current place, count descending then name. Absent (older
    /// servers) or `null` decodes as none.
    let countries: [CountryCountDTO]
    /// Cities of photos with a current place, count descending then name. Absent or `null`
    /// decodes as none.
    let places: [PlaceCountDTO]

    init(
        cameras: [String],
        lenses: [String],
        isos: [Int],
        dates: [String],
        tags: [TagCountDTO] = [],
        countries: [CountryCountDTO] = [],
        places: [PlaceCountDTO] = []
    ) {
        self.cameras = cameras
        self.lenses = lenses
        self.isos = isos
        self.dates = dates
        self.tags = tags
        self.countries = countries
        self.places = places
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        cameras = try container.decode([String].self, forKey: .cameras)
        lenses = try container.decode([String].self, forKey: .lenses)
        isos = try container.decode([Int].self, forKey: .isos)
        dates = try container.decode([String].self, forKey: .dates)
        tags = try container.decodeIfPresent([TagCountDTO].self, forKey: .tags) ?? []
        countries = try container.decodeIfPresent([CountryCountDTO].self, forKey: .countries) ?? []
        places = try container.decodeIfPresent([PlaceCountDTO].self, forKey: .places) ?? []
    }
}

/// One auto tag slug (e.g. `night-sky`) and how many photos in scope carry it.
struct TagCountDTO: Codable, Hashable, Identifiable, Sendable {
    var id: String { tag }
    let tag: String
    let count: Int
}

/// One auto tag on a photo; `score` is the label's zero-shot probability (0-1).
struct PhotoTagDTO: Codable, Hashable, Identifiable, Sendable {
    var id: String { tag }
    let tag: String
    let score: Double
}

/// `GET /api/v1/photos/:id/tags`, highest score first.
struct PhotoTagsResponseDTO: Codable, Equatable, Sendable {
    let tags: [PhotoTagDTO]
}

/// A country (ISO 3166-1 alpha-2 `code`, e.g. `JP`) and how many photos in scope were taken there.
struct CountryCountDTO: Codable, Hashable, Identifiable, Sendable {
    var id: String { code }
    let code: String
    let name: String
    let count: Int
}

/// A city (GeoNames id) and how many photos in scope were taken there.
struct PlaceCountDTO: Codable, Hashable, Identifiable, Sendable {
    let id: Int
    let name: String
    /// First-level administrative region (state, prefecture); `nil` when unknown.
    let region: String?
    let countryCode: String
    let count: Int
}

/// The nearest city (within 100 km) to a photo's coordinates, from the offline GeoNames dataset.
struct PhotoPlaceDTO: Codable, Hashable, Identifiable, Sendable {
    /// GeoNames id; the `place` filter value.
    let id: Int
    let city: String
    let region: String?
    let country: String
    let countryCode: String
}

/// `GET /api/v1/photos/:id/place`; `place` is `nil` when the photo has no current place.
struct PhotoPlaceResponseDTO: Codable, Equatable, Sendable {
    let place: PhotoPlaceDTO?
}

struct PhotoEXIFDTO: Codable, Hashable, Sendable {
    let id: Int
    let photoId: Int
    let cameraMake: String?
    let cameraModel: String?
    let lensMake: String?
    let lensModel: String?
    let focalLength: Int?
    let iso: Int?
    let aperture: String?
    let shutterSpeed: String?
    let exposureBias: String?
    let dateTaken: String?
    let gpsLatitude: String?
    let gpsLongitude: String?
    let gpsAltitude: String?

    var capturedAt: Date? {
        PhotoDateResolver.parseCaptureDate(dateTaken)
    }

    var cameraDescription: String? {
        joined(cameraMake, cameraModel)
    }

    var lensDescription: String? {
        joined(lensMake, lensModel)
    }

    private func joined(_ first: String?, _ second: String?) -> String? {
        let parts: [String] = [first, second].compactMap { value -> String? in
            guard let value, !value.isEmpty else { return nil }
            return value
        }
        guard !parts.isEmpty else { return nil }
        if parts.count == 2,
           parts[1].range(
               of: parts[0],
               options: [.anchored, .caseInsensitive],
               locale: .current
           ) != nil {
            return parts[1]
        }
        return parts.joined(separator: " ")
    }
}

private extension ISO8601DateFormatter {
    static let fractional: ISO8601DateFormatter = {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter
    }()

    static let internet = ISO8601DateFormatter()
}

/// Culling flag set from the loupe; `nil` on a photo means unflagged.
enum PhotoFlag: String, Codable, CaseIterable, Hashable, Sendable {
    case pick
    case reject
}

/// `photos.mediaType`. Servers that predate video support omit it; it then decodes as `.photo`.
enum PhotoMediaType: String, Codable, Hashable, Sendable {
    case photo
    case video
}

/// Flag filter accepted by `GET /photos` and `POST /search`.
enum PhotoFlagFilter: String, CaseIterable, Identifiable, Hashable, Sendable {
    case pick
    case reject
    case unflagged

    var id: Self { self }
    var title: String {
        switch self {
        case .pick: "Picks"
        case .reject: "Rejected"
        case .unflagged: "Unflagged"
        }
    }
}

struct PhotoDTO: Codable, Hashable, Identifiable, Sendable {
    let id: Int
    let path: String
    let name: String
    let size: Int
    let createdAt: Date
    let modifiedAt: Date
    let width: Int?
    let height: Int?
    let mimeType: String?
    let isRaw: Bool?
    let rawFormat: String?
    let rawStatus: String?
    let rawError: String?
    let thumbnailStatus: String?
    let thumbnailUpdatedAt: Date?
    let embeddingStatus: String?
    let phashStatus: String?
    let exif: PhotoEXIFDTO?
    /// 0-5; servers that predate curation omit it and decode as 0.
    let rating: Int
    /// Servers that predate curation omit it and decode as unflagged.
    let flag: PhotoFlag?
    /// RAW+JPEG partner (same folder and stem). Servers that predate pairing omit both and
    /// decode as unpaired.
    let pairedPhotoId: Int?
    /// Partner's `rawFormat` when it is RAW, else its upper-cased extension (e.g. `JPG`).
    let pairedFormat: String?
    /// Junk-review reasons (only populated by `GET /review/junk`); unknown values are dropped.
    var junkReasons: [JunkReason] = []
    /// Missing (older servers) or unknown values decode as `.photo`.
    var mediaType: PhotoMediaType = .photo
    /// Video length; nil for stills and videos whose duration could not be probed.
    var durationMs: Int?
    /// ffprobe codec name of the first video stream, e.g. `hevc`; nil for stills.
    var videoCodec: String?
    /// Live Photo motion clip of this still (a short same-stem video, hidden from listings).
    var motionVideoId: Int?
}

extension PhotoDTO {
    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        id = try container.decode(Int.self, forKey: .id)
        path = try container.decode(String.self, forKey: .path)
        name = try container.decode(String.self, forKey: .name)
        size = try container.decode(Int.self, forKey: .size)
        createdAt = try container.decode(Date.self, forKey: .createdAt)
        modifiedAt = try container.decode(Date.self, forKey: .modifiedAt)
        width = try container.decodeIfPresent(Int.self, forKey: .width)
        height = try container.decodeIfPresent(Int.self, forKey: .height)
        mimeType = try container.decodeIfPresent(String.self, forKey: .mimeType)
        isRaw = try container.decodeIfPresent(Bool.self, forKey: .isRaw)
        rawFormat = try container.decodeIfPresent(String.self, forKey: .rawFormat)
        rawStatus = try container.decodeIfPresent(String.self, forKey: .rawStatus)
        rawError = try container.decodeIfPresent(String.self, forKey: .rawError)
        thumbnailStatus = try container.decodeIfPresent(String.self, forKey: .thumbnailStatus)
        thumbnailUpdatedAt = try container.decodeIfPresent(Date.self, forKey: .thumbnailUpdatedAt)
        embeddingStatus = try container.decodeIfPresent(String.self, forKey: .embeddingStatus)
        phashStatus = try container.decodeIfPresent(String.self, forKey: .phashStatus)
        exif = try container.decodeIfPresent(PhotoEXIFDTO.self, forKey: .exif)
        rating = try container.decodeIfPresent(Int.self, forKey: .rating) ?? 0
        flag = try container.decodeIfPresent(PhotoFlag.self, forKey: .flag)
        pairedPhotoId = try container.decodeIfPresent(Int.self, forKey: .pairedPhotoId)
        pairedFormat = try container.decodeIfPresent(String.self, forKey: .pairedFormat)
        junkReasons = (try container.decodeIfPresent([String].self, forKey: .junkReasons) ?? [])
            .compactMap(JunkReason.init(rawValue:))
        mediaType = try container.decodeIfPresent(String.self, forKey: .mediaType)
            .flatMap(PhotoMediaType.init(rawValue:)) ?? .photo
        durationMs = try container.decodeIfPresent(Int.self, forKey: .durationMs)
        videoCodec = try container.decodeIfPresent(String.self, forKey: .videoCodec)
        motionVideoId = try container.decodeIfPresent(Int.self, forKey: .motionVideoId)
    }
}

struct PhotosResponseDTO: Codable, Equatable, Sendable {
    let photos: [PhotoDTO]
    let total: Int
    let rawCount: Int
}

struct SearchResponseDTO: Codable, Equatable, Sendable {
    let photos: [PhotoDTO]
    let total: Int
    let query: String
}

/// A latitude/longitude box in decimal degrees, edges inclusive. `west > east` crosses the
/// antimeridian. Sent as `north`/`south`/`east`/`west` query items or a JSON `bounds` object.
struct PhotoBounds: Codable, Hashable, Sendable {
    let north: Double
    let south: Double
    let east: Double
    let west: Double

    /// Whether the point lies inside the box, using the server's antimeridian rule.
    func contains(latitude: Double, longitude: Double) -> Bool {
        guard latitude >= south, latitude <= north else { return false }
        if west <= east {
            return longitude >= west && longitude <= east
        }
        return longitude >= west || longitude <= east
    }
}

/// One geotagged photo on the map. Coordinates are decimal degrees the server already
/// validated (finite, in range, not 0,0).
struct PhotoLocationPointDTO: Codable, Hashable, Identifiable, Sendable {
    let id: Int
    let latitude: Double
    let longitude: Double
}

/// `GET /api/v1/locations`: every photo matching the filters that has a valid location, by id.
struct LocationsResponseDTO: Codable, Equatable, Sendable {
    let points: [PhotoLocationPointDTO]
    let total: Int
}

/// `POST /api/v1/search` body. `filterRaw` is always sent; optional filters are omitted when nil.
struct SearchRequestDTO: Encodable, Equatable, Sendable {
    let query: String
    let limit: Int
    let filterRaw: String
    let folder: String?
    let camera: String?
    let lens: String?
    let iso: Int?
    let dateMonth: String?
    let minRating: Int?
    let flag: String?
    let collectionId: Int?
    let tag: String?
    let personId: Int?
    let country: String?
    let place: Int?
    let bounds: PhotoBounds?
    let capturedDate: String?
    let event: Int?

    init(query: String, limit: Int, filters: PhotoQuery) {
        self.query = query
        self.limit = limit
        filterRaw = filters.filterRaw.rawValue
        folder = filters.folder
        camera = filters.camera
        lens = filters.lens
        iso = filters.iso
        dateMonth = filters.dateMonth
        minRating = filters.minRating
        flag = filters.flag?.rawValue
        collectionId = filters.collectionId
        tag = filters.tag
        personId = filters.personId
        country = filters.country
        place = filters.place
        bounds = filters.bounds
        capturedDate = filters.capturedDate
        event = filters.event
    }
}

/// `PATCH /api/v1/photos/:id` body. Only provided keys are encoded; clearing the flag
/// (`flag: .some(nil)`) encodes an explicit JSON `null`, while `flag: nil` omits the key.
struct CurationPatchDTO: Encodable, Equatable, Sendable {
    let rating: Int?
    let flag: PhotoFlag??

    private enum CodingKeys: String, CodingKey {
        case rating
        case flag
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encodeIfPresent(rating, forKey: .rating)
        guard case let .some(flag) = flag else { return }
        if let flag {
            try container.encode(flag, forKey: .flag)
        } else {
            try container.encodeNil(forKey: .flag)
        }
    }
}

struct SimilarPhotosResponseDTO: Codable, Equatable, Sendable {
    let photos: [PhotoDTO]
    let total: Int
    let sourcePhotoId: Int
    let indexed: Bool
}

/// Why a photo is in the junk review, in the server's precedence order.
enum JunkReason: String, Codable, CaseIterable, Identifiable, Hashable, Sendable {
    case screenshot
    case document
    case blurry
    case dark

    var id: Self { self }
    var title: String {
        switch self {
        case .screenshot: "Screenshots"
        case .document: "Documents"
        case .blurry: "Blurry"
        case .dark: "Too dark"
        }
    }
}

/// Candidate totals over the whole review, independent of the reason filter and cursor.
/// A photo counts once in `all` and once under each of its reasons.
struct JunkCountsDTO: Codable, Equatable, Sendable {
    var all: Int
    var screenshot: Int
    var document: Int
    var blurry: Int
    var dark: Int

    static let zero = JunkCountsDTO(all: 0, screenshot: 0, document: 0, blurry: 0, dark: 0)

    /// `nil` is the unfiltered ("All") total.
    func count(for reason: JunkReason?) -> Int {
        let value: Int
        switch reason {
        case nil: value = all
        case .screenshot: value = screenshot
        case .document: value = document
        case .blurry: value = blurry
        case .dark: value = dark
        }
        return max(0, value)
    }

    /// Adds `delta` to `all` and to every listed reason for one photo.
    mutating func adjust(reasons: [JunkReason], by delta: Int) {
        all += delta
        for reason in reasons {
            switch reason {
            case .screenshot: screenshot += delta
            case .document: document += delta
            case .blurry: blurry += delta
            case .dark: dark += delta
            }
        }
    }
}

/// `GET /api/v1/review/junk`: candidates newest first; `nextCursor` is the photo id to resume after.
struct JunkReviewResponseDTO: Codable, Equatable, Sendable {
    /// Largest `limit` the route accepts.
    static let maximumLimit = 500

    let photos: [PhotoDTO]
    let nextCursor: Int?
    let counts: JunkCountsDTO
}

/// Review decision: `reject` sets the reject flag; `keep` dismisses the photo from review for good.
enum JunkAction: String, Codable, Hashable, Sendable {
    case reject
    case keep
}

/// `POST /api/v1/review/junk/resolve` body.
struct ResolveJunkRequestDTO: Encodable, Equatable, Sendable {
    let photoIds: [Int]
    let action: JunkAction
}

/// Ids the server actually changed; unknown ids are skipped.
struct ResolveJunkResponseDTO: Codable, Equatable, Sendable {
    let updated: [Int]
}

/// Why photos are grouped on the Duplicates screen.
enum DuplicateKind: String, Codable, CaseIterable, Identifiable, Hashable, Sendable {
    /// Near-identical perceptual hashes.
    case duplicate
    /// Same camera, shots at most two seconds apart.
    case burst

    var id: Self { self }
    var title: String {
        switch self {
        case .duplicate: "Duplicates"
        case .burst: "Bursts"
        }
    }
}

/// Group totals per kind after dismissals, independent of the kind filter and cursor.
struct DuplicateCountsDTO: Codable, Equatable, Sendable {
    var duplicate: Int
    var burst: Int

    static let zero = DuplicateCountsDTO(duplicate: 0, burst: 0)

    /// Every group across both kinds; the Library entry badge.
    var total: Int { max(0, duplicate) + max(0, burst) }

    /// `nil` is the unfiltered ("All") total.
    func count(for kind: DuplicateKind?) -> Int {
        switch kind {
        case nil: total
        case .duplicate: max(0, duplicate)
        case .burst: max(0, burst)
        }
    }

    mutating func adjust(_ kind: DuplicateKind, by delta: Int) {
        switch kind {
        case .duplicate: duplicate += delta
        case .burst: burst += delta
        }
    }
}

/// One duplicate or burst group. `key` identifies its exact membership; photos are keeper first.
struct DuplicateGroupDTO: Codable, Equatable, Sendable {
    let key: String
    let kind: DuplicateKind
    let photos: [PhotoDTO]
    let suggestedKeeperId: Int
    /// Largest pairwise hash distance in a duplicate group; `null` for bursts.
    let maxDistance: Int?
}

/// `GET /api/v1/duplicates`: largest groups first. `nextCursor` is opaque.
///
/// Groups of a kind this client does not know are dropped instead of failing the page.
struct DuplicateGroupsResponseDTO: Decodable, Equatable, Sendable {
    /// Largest `limit` the route accepts.
    static let maximumLimit = 200

    let groups: [DuplicateGroupDTO]
    let counts: DuplicateCountsDTO
    let nextCursor: String?

    init(groups: [DuplicateGroupDTO], counts: DuplicateCountsDTO, nextCursor: String?) {
        self.groups = groups
        self.counts = counts
        self.nextCursor = nextCursor
    }

    private enum CodingKeys: String, CodingKey {
        case groups
        case counts
        case nextCursor
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        groups = try container.decode([KnownKindGroup].self, forKey: .groups).compactMap(\.group)
        counts = try container.decode(DuplicateCountsDTO.self, forKey: .counts)
        nextCursor = try container.decodeIfPresent(String.self, forKey: .nextCursor)
    }

    /// Decodes a group only when its kind is known; other fields of unknown kinds are not read.
    private struct KnownKindGroup: Decodable {
        let group: DuplicateGroupDTO?

        private enum KindKey: String, CodingKey {
            case kind
        }

        init(from decoder: Decoder) throws {
            let kind = try decoder.container(keyedBy: KindKey.self).decode(String.self, forKey: .kind)
            group = try DuplicateKind(rawValue: kind).map { _ in try DuplicateGroupDTO(from: decoder) }
        }
    }
}

/// Group decision: keep the listed members and reject the rest, or mark it "not duplicates".
enum DuplicateResolution: Equatable, Sendable {
    case keep([Int])
    case dismiss
}

/// `POST /api/v1/duplicates/resolve` body; `keepIds` is omitted for `dismiss`.
struct ResolveDuplicateGroupRequestDTO: Encodable, Equatable, Sendable {
    enum Action: String, Encodable, Sendable {
        case keep
        case dismiss
    }

    let key: String
    let action: Action
    let keepIds: [Int]?

    init(key: String, resolution: DuplicateResolution) {
        self.key = key
        switch resolution {
        case let .keep(ids):
            action = .keep
            keepIds = ids
        case .dismiss:
            action = .dismiss
            keepIds = nil
        }
    }
}

/// `keep` returns the rejected member ids; `dismiss` echoes the dismissed key.
struct ResolveDuplicateGroupResponseDTO: Codable, Equatable, Sendable {
    var rejected: [Int]?
    var dismissed: String?
}

enum ScanPhase: String, Codable, CaseIterable, Hashable, Sendable {
    case queued
    case discovering
    case processing
    case scanComplete = "scan-complete"
    case embedding
    case completed
    case failed
}

enum ScanStatus: String, Codable, CaseIterable, Hashable, Sendable {
    case queued
    case running
    case completed
    case failed
}

struct ScanDTO: Codable, Hashable, Identifiable, Sendable {
    let id: String
    let phase: ScanPhase
    let current: Int
    let total: Int
    let status: ScanStatus
    let error: String?
    let createdAt: Date
    let updatedAt: Date

    var isTerminal: Bool {
        status == .completed
            || status == .failed
            || phase == .completed
            || phase == .failed
    }

    var isFailed: Bool {
        status == .failed || phase == .failed
    }

    var fractionCompleted: Double? {
        guard total > 0 else { return nil }
        return min(1, max(0, Double(current) / Double(total)))
    }
}

struct ActiveScansResponseDTO: Codable, Equatable, Sendable {
    let jobs: [ScanDTO]
}

struct StartScanRequestDTO: Codable, Equatable, Sendable {
    let force: Bool
}

struct StartScanResponseDTO: Codable, Equatable, Sendable {
    let success: Bool
    let jobId: String?
    let error: String?

    init(success: Bool, jobId: String?, error: String? = nil) {
        self.success = success
        self.jobId = jobId
        self.error = error
    }
}

/// The kind of original an upload carries; one per PhotoKit resource the backup sends.
enum UploadResource: String, Codable, CaseIterable, Hashable, Sendable {
    case photo
    case video
    case pairedVideo
    case alternatePhoto
}

/// `GET /uploads/config`. `extensions` are lower-case with the leading dot.
struct UploadConfigDTO: Codable, Equatable, Sendable {
    let enabled: Bool
    let maxBytes: Int64
    let extensions: [String]
}

struct KnownUploadsRequestDTO: Codable, Equatable, Sendable {
    let deviceId: String
    let assetIds: [String]
}

/// `POST /uploads/known`: only assets with at least one recorded resource are listed.
struct KnownUploadsResponseDTO: Codable, Equatable, Sendable {
    struct Asset: Codable, Equatable, Sendable {
        let assetId: String
        let resources: [UploadResource]
    }

    let assets: [Asset]
}

/// `POST /uploads` success body: `201 created` or `200 duplicate`.
struct UploadResultDTO: Codable, Equatable, Sendable {
    enum Status: String, Codable, Sendable {
        case created
        case duplicate
    }

    let status: Status
    let path: String
    let size: Int64
}

struct CollectionCoverDTO: Codable, Hashable, Sendable {
    let photoId: Int
    let thumbnailUpdatedAt: Date?
}

struct CollectionDTO: Codable, Hashable, Identifiable, Sendable {
    let id: Int
    let name: String
    /// Mutable so membership responses can patch the count without refetching the list.
    var photoCount: Int
    /// Most recently added photo still present; `nil` for an empty collection.
    let cover: CollectionCoverDTO?
    let createdAt: Date
    let updatedAt: Date

    /// Medium cover thumbnail, versioned by the cover photo's `thumbnailUpdatedAt`.
    func coverURL(apiBaseURL: URL) -> URL? {
        guard let cover else { return nil }
        return PhotoRecord.thumbnailURL(
            baseURL: apiBaseURL,
            id: cover.photoId,
            size: "medium",
            updatedAt: cover.thumbnailUpdatedAt
        )
    }
}

/// One earlier year's photos captured on the requested month and day.
struct OnThisDayYearDTO: Codable, Hashable, Identifiable, Sendable {
    var id: Int { year }
    let year: Int
    let yearsAgo: Int
    /// `YYYY-MM-DD` to apply as the `capturedDate` filter (Feb 29 when a non-leap Feb 28
    /// request matched only that year's leap-day photos).
    let capturedDate: String
    let count: Int
    let cover: CollectionCoverDTO

    /// Small cover thumbnail, versioned by the cover photo's `thumbnailUpdatedAt`.
    func coverURL(apiBaseURL: URL) -> URL {
        PhotoRecord.thumbnailURL(
            baseURL: apiBaseURL,
            id: cover.photoId,
            size: "small",
            updatedAt: cover.thumbnailUpdatedAt
        )
    }
}

/// `GET /api/v1/on-this-day`: years strictly before `date`'s year with matching photos, most
/// recent first (at most 20).
struct OnThisDayResponseDTO: Codable, Equatable, Sendable {
    let date: String
    let years: [OnThisDayYearDTO]
}

/// An auto event's place: a city (with its country) when most located members share it, or
/// only a country (`city`/`region` nil) when most share that.
struct EventPlaceDTO: Codable, Hashable, Sendable {
    let city: String?
    let region: String?
    let country: String
    let countryCode: String
}

/// One auto event: a run of photos captured close together. `startAt`/`endAt` are EXIF
/// wall-clock capture times `YYYY-MM-DDTHH:MM:SS` with no zone; `id` is applied as the `event`
/// filter.
struct EventDTO: Codable, Hashable, Identifiable, Sendable {
    let id: Int
    let startAt: String
    let endAt: String
    let photoCount: Int
    let cover: CollectionCoverDTO
    let place: EventPlaceDTO?

    /// Medium cover thumbnail, versioned by the cover photo's `thumbnailUpdatedAt`.
    func coverURL(apiBaseURL: URL) -> URL {
        PhotoRecord.thumbnailURL(
            baseURL: apiBaseURL,
            id: cover.photoId,
            size: "medium",
            updatedAt: cover.thumbnailUpdatedAt
        )
    }
}

/// `GET /api/v1/events`: auto events newest first (by `startAt`, then `id`, descending).
struct EventsResponseDTO: Codable, Equatable, Sendable {
    let events: [EventDTO]
}

/// One camera or lens label and how many photos in scope carry it.
struct GearCountDTO: Codable, Hashable, Sendable {
    let label: String
    let count: Int
}

/// One fixed histogram bucket. `min`/`max` are `nil` for the open first/last buckets; the
/// server always sends every bucket in ascending order, including zero counts.
struct GearBucketDTO: Codable, Hashable, Sendable {
    let label: String
    let min: Double?
    let max: Double?
    let count: Int
}

/// Photos by one camera in one EXIF capture year.
struct GearCameraYearDTO: Codable, Hashable, Sendable {
    let camera: String
    let year: Int
    let count: Int
}

/// `GET /api/v1/gear-stats`: gear usage over exactly the photos `GET /photos` lists for the
/// same filters. `cameras`/`lenses` hold every entry, count descending then label;
/// `cameraYears` is year ascending, then count descending, then camera.
struct GearStatsDTO: Codable, Equatable, Sendable {
    let total: Int
    /// Photos with any camera, lens, focal length, aperture, shutter speed, or ISO value.
    let withExif: Int
    let cameras: [GearCountDTO]
    let lenses: [GearCountDTO]
    let focalLengths: [GearBucketDTO]
    let apertures: [GearBucketDTO]
    let shutterSpeeds: [GearBucketDTO]
    let isos: [GearBucketDTO]
    let cameraYears: [GearCameraYearDTO]
}

struct CollectionsResponseDTO: Codable, Equatable, Sendable {
    let collections: [CollectionDTO]
}

/// `POST /api/v1/collections` body; `photoIds` is omitted when nil.
struct CreateCollectionRequestDTO: Encodable, Equatable, Sendable {
    let name: String
    let photoIds: [Int]?
}

struct RenameCollectionRequestDTO: Encodable, Equatable, Sendable {
    let name: String
}

struct CollectionPhotosRequestDTO: Encodable, Equatable, Sendable {
    let photoIds: [Int]
}

struct CollectionPhotosAddedDTO: Codable, Equatable, Sendable {
    let added: Int
    let photoCount: Int
}

struct CollectionPhotosRemovedDTO: Codable, Equatable, Sendable {
    let removed: Int
    let photoCount: Int
}

struct PhotoCollectionsDTO: Codable, Equatable, Sendable {
    let collectionIds: [Int]
}

/// Client-side mirror of the server's collection name rule: trimmed, 1-100 UTF-16 units.
enum CollectionName {
    static let maximumLength = 100
    /// Largest photo-id batch accepted by membership routes.
    static let maximumPhotoBatch = 500

    static func validated(_ raw: String) throws -> String {
        let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { throw CollectionNameError.empty }
        guard trimmed.utf16.count <= maximumLength else { throw CollectionNameError.tooLong }
        return trimmed
    }
}

enum CollectionNameError: Error, Equatable, LocalizedError, Sendable {
    case empty
    case tooLong

    var errorDescription: String? {
        switch self {
        case .empty: "Enter a collection name."
        case .tooLong: "Collection names can be at most \(CollectionName.maximumLength) characters."
        }
    }
}

/// Saved criteria of a smart album: the `PhotoQuery` filters without collection scope or map
/// bounds.
/// Decoding is tolerant: unknown keys are ignored, `filterRaw` `"all"` (or an unknown value)
/// means no media filter, unknown flag values are dropped, and `dateMonth` is normalized to
/// `YYYY-MM` (the `/api/v1` representation used by filter options). Encoding omits nil keys.
struct SmartAlbumFilters: Codable, Hashable, Sendable {
    /// `.raw`, `.standard`, or `.video`; `nil` means every media kind.
    var filterRaw: LibraryFilters.MediaKind?
    var folder: String?
    var camera: String?
    var lens: String?
    var iso: Int?
    var dateMonth: String?
    var minRating: Int?
    var flag: PhotoFlagFilter?
    var tag: String?
    /// Only photos with a face assigned to this person.
    var personId: Int?
    /// ISO 3166-1 alpha-2 country code of the photos' place.
    var country: String?
    /// GeoNames city id of the photos' place.
    var place: Int?

    private enum CodingKeys: String, CodingKey {
        case filterRaw, folder, camera, lens, iso, dateMonth, minRating, flag, tag, personId, country, place
    }

    init(
        filterRaw: LibraryFilters.MediaKind? = nil,
        folder: String? = nil,
        camera: String? = nil,
        lens: String? = nil,
        iso: Int? = nil,
        dateMonth: String? = nil,
        minRating: Int? = nil,
        flag: PhotoFlagFilter? = nil,
        tag: String? = nil,
        personId: Int? = nil,
        country: String? = nil,
        place: Int? = nil
    ) {
        self.filterRaw = filterRaw == .all ? nil : filterRaw
        self.folder = folder
        self.camera = camera
        self.lens = lens
        self.iso = iso
        self.dateMonth = dateMonth.map(Self.normalizedMonth)
        self.minRating = minRating
        self.flag = flag
        self.tag = tag
        self.personId = personId
        self.country = country
        self.place = place
    }

    /// The Library/Search filter set as saved criteria (those screens have no folder filter).
    /// View scopes (map `bounds`, On this day `capturedDate`, auto `event`) are never saved
    /// criteria, so they are dropped.
    init(_ filters: LibraryFilters) {
        self.init(
            filterRaw: filters.mediaKind,
            camera: filters.camera,
            lens: filters.lens,
            iso: filters.iso,
            dateMonth: filters.dateMonth,
            minRating: filters.minRating,
            flag: filters.flag,
            tag: filters.tag,
            country: filters.country?.code,
            place: filters.place?.id
        )
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        self.init(
            filterRaw: try container.decodeIfPresent(String.self, forKey: .filterRaw)
                .flatMap(LibraryFilters.MediaKind.init(rawValue:)),
            folder: try container.decodeIfPresent(String.self, forKey: .folder),
            camera: try container.decodeIfPresent(String.self, forKey: .camera),
            lens: try container.decodeIfPresent(String.self, forKey: .lens),
            iso: try container.decodeIfPresent(Int.self, forKey: .iso),
            dateMonth: try container.decodeIfPresent(String.self, forKey: .dateMonth),
            minRating: try container.decodeIfPresent(Int.self, forKey: .minRating),
            flag: try container.decodeIfPresent(String.self, forKey: .flag).flatMap(PhotoFlagFilter.init(rawValue:)),
            tag: try container.decodeIfPresent(String.self, forKey: .tag),
            personId: try container.decodeIfPresent(Int.self, forKey: .personId),
            country: try container.decodeIfPresent(String.self, forKey: .country),
            place: try container.decodeIfPresent(Int.self, forKey: .place)
        )
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encodeIfPresent(filterRaw?.rawValue, forKey: .filterRaw)
        try container.encodeIfPresent(folder, forKey: .folder)
        try container.encodeIfPresent(camera, forKey: .camera)
        try container.encodeIfPresent(lens, forKey: .lens)
        try container.encodeIfPresent(iso, forKey: .iso)
        try container.encodeIfPresent(dateMonth, forKey: .dateMonth)
        try container.encodeIfPresent(minRating, forKey: .minRating)
        try container.encodeIfPresent(flag?.rawValue, forKey: .flag)
        try container.encodeIfPresent(tag, forKey: .tag)
        try container.encodeIfPresent(personId, forKey: .personId)
        try container.encodeIfPresent(country, forKey: .country)
        try container.encodeIfPresent(place, forKey: .place)
    }

    var isEmpty: Bool {
        filterRaw == nil && folder == nil && camera == nil && lens == nil && iso == nil
            && dateMonth == nil && minRating == nil && flag == nil && tag == nil && personId == nil
            && country == nil && place == nil
    }

    /// Wire filters for `GET /photos` and `POST /search`.
    var photoQuery: PhotoQuery {
        PhotoQuery(
            filterRaw: filterRaw ?? .all,
            folder: folder,
            camera: camera,
            lens: lens,
            iso: iso,
            dateMonth: dateMonth,
            minRating: minRating,
            flag: flag,
            tag: tag,
            personId: personId,
            country: country,
            place: place
        )
    }

    /// Accepts the stored-EXIF `YYYY:MM` form as well as `YYYY-MM`.
    private static func normalizedMonth(_ value: String) -> String {
        value.replacingOccurrences(of: ":", with: "-")
    }
}

struct SmartAlbumDTO: Codable, Hashable, Identifiable, Sendable {
    let id: Int
    /// Mutable so an optimistic rename can patch the list before the server confirms it.
    var name: String
    let filters: SmartAlbumFilters
    /// Semantic search text; `nil` for filter-only albums.
    let query: String?
    /// Live match count; `nil` for query albums (vector search has no stable count).
    let photoCount: Int?
    /// Highest-id matching photo; `nil` for query albums and albums with no matches.
    let cover: CollectionCoverDTO?
    let createdAt: Date
    let updatedAt: Date

    /// Medium cover thumbnail, versioned by the cover photo's `thumbnailUpdatedAt`.
    func coverURL(apiBaseURL: URL) -> URL? {
        guard let cover else { return nil }
        return PhotoRecord.thumbnailURL(
            baseURL: apiBaseURL,
            id: cover.photoId,
            size: "medium",
            updatedAt: cover.thumbnailUpdatedAt
        )
    }
}

struct SmartAlbumsResponseDTO: Codable, Equatable, Sendable {
    let albums: [SmartAlbumDTO]
}

/// `POST /api/v1/smart-albums` body; `query` is omitted for filter-only albums.
struct CreateSmartAlbumRequestDTO: Encodable, Equatable, Sendable {
    let name: String
    let filters: SmartAlbumFilters
    let query: String?
}

/// `PATCH /api/v1/smart-albums/:id` body for a rename; filters and query are left unchanged.
struct RenameSmartAlbumRequestDTO: Encodable, Equatable, Sendable {
    let name: String
}

/// Client-side mirror of the server's smart album rules: names trimmed to 1-100 UTF-16 units,
/// queries trimmed to at most 200 (blank means none), and at least one filter or a query.
enum SmartAlbumDraft {
    static let maximumNameLength = 100
    static let maximumQueryLength = 200

    static func validatedName(_ raw: String) throws -> String {
        let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { throw SmartAlbumValidationError.emptyName }
        guard trimmed.utf16.count <= maximumNameLength else { throw SmartAlbumValidationError.nameTooLong }
        return trimmed
    }

    /// Returns the trimmed query, or `nil` when it is absent or blank.
    static func validatedQuery(_ raw: String?) throws -> String? {
        guard let trimmed = raw?.trimmingCharacters(in: .whitespacesAndNewlines), !trimmed.isEmpty else {
            return nil
        }
        guard trimmed.utf16.count <= maximumQueryLength else { throw SmartAlbumValidationError.queryTooLong }
        return trimmed
    }

    static func validated(
        name: String,
        filters: SmartAlbumFilters,
        query: String?
    ) throws -> CreateSmartAlbumRequestDTO {
        let name = try validatedName(name)
        let query = try validatedQuery(query)
        guard query != nil || !filters.isEmpty else { throw SmartAlbumValidationError.noCriteria }
        return CreateSmartAlbumRequestDTO(name: name, filters: filters, query: query)
    }
}

enum SmartAlbumValidationError: Error, Equatable, LocalizedError, Sendable {
    case emptyName
    case nameTooLong
    case queryTooLong
    case noCriteria

    var errorDescription: String? {
        switch self {
        case .emptyName: "Enter a smart album name."
        case .nameTooLong: "Smart album names can be at most \(SmartAlbumDraft.maximumNameLength) characters."
        case .queryTooLong: "Searches can be at most \(SmartAlbumDraft.maximumQueryLength) characters."
        case .noCriteria: "Choose at least one filter or enter a search."
        }
    }
}

// MARK: - People

/// `GET /api/v1/people` entry. Unnamed people have a `nil` name; `coverFaceId` is the
/// person's highest-score face, `nil` when they have none.
struct PersonDTO: Codable, Hashable, Identifiable, Sendable {
    let id: Int
    /// Mutable so optimistic rename/hide/merge can patch the list before the server confirms.
    var name: String?
    var hidden: Bool
    /// Distinct listed photos (a RAW+JPEG pair counts once).
    var photoCount: Int
    var faceCount: Int
    var coverFaceId: Int?

    /// The cover face crop, or `nil` without a cover face.
    func coverURL(apiBaseURL: URL, size: Int = FaceCrop.defaultSize) -> URL? {
        coverFaceId.map { FaceCrop.url(baseURL: apiBaseURL, faceID: $0, size: size) }
    }
}

struct PeopleResponseDTO: Codable, Equatable, Sendable {
    let people: [PersonDTO]
}

/// `PATCH /api/v1/people/:id` body. Only provided keys are encoded; clearing the name
/// (`name: .some(nil)`) encodes an explicit JSON `null`, while `name: nil` omits the key.
struct UpdatePersonRequestDTO: Encodable, Equatable, Sendable {
    let name: String??
    let hidden: Bool?

    private enum CodingKeys: String, CodingKey {
        case name
        case hidden
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        if case let .some(name) = name {
            if let name {
                try container.encode(name, forKey: .name)
            } else {
                try container.encodeNil(forKey: .name)
            }
        }
        try container.encodeIfPresent(hidden, forKey: .hidden)
    }
}

/// `POST /api/v1/people/:id/merge` body.
struct MergePeopleRequestDTO: Encodable, Equatable, Sendable {
    let sourceIds: [Int]
}

/// A face rectangle normalized to 0...1 of the oriented image, origin top-left.
struct FaceBoxDTO: Codable, Hashable, Sendable {
    let x: Double
    let y: Double
    let width: Double
    let height: Double
}

/// How a face got its person: automatic grouping, a user's choice, or a user's rejection.
enum FaceAssignment: String, Codable, Hashable, Sendable {
    case auto
    case manual
    case rejected
}

/// `GET /api/v1/photos/:id/faces` entry and the `PUT /api/v1/faces/:id/person` response.
struct PhotoFaceDTO: Codable, Hashable, Identifiable, Sendable {
    let id: Int
    let box: FaceBoxDTO
    /// Mutable so an optimistic assignment can patch the face before the server confirms.
    var personId: Int?
    var personName: String?
    var assignment: FaceAssignment
}

/// A photo's faces, ordered left to right.
struct PhotoFacesResponseDTO: Codable, Equatable, Sendable {
    let faces: [PhotoFaceDTO]
}

/// What `PUT /api/v1/faces/:id/person` does with a face.
enum FaceAssignmentTarget: Hashable, Sendable {
    /// Assigns the face to an existing person: `{"personId": id}`.
    case person(Int)
    /// Creates a named person holding the face: `{"name": name}`.
    case newPerson(name: String)
    /// Rejects the face from any person: `{"personId": null}`.
    case notThisPerson

    /// Trims and checks the new person's name and the person id, as the server does.
    func validated() throws -> Self {
        switch self {
        case let .person(id):
            guard id > 0 else { throw PhotoBrainAPIError.invalidRequest }
            return self
        case let .newPerson(name):
            return .newPerson(name: try PersonName.validated(name))
        case .notThisPerson:
            return self
        }
    }
}

struct AssignFaceRequestDTO: Encodable, Equatable, Sendable {
    let target: FaceAssignmentTarget

    private enum CodingKeys: String, CodingKey {
        case personId
        case name
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        switch target {
        case let .person(id): try container.encode(id, forKey: .personId)
        case let .newPerson(name): try container.encode(name, forKey: .name)
        case .notThisPerson: try container.encodeNil(forKey: .personId)
        }
    }
}

/// Client-side mirror of the server's person name rule: trimmed, 1-80 UTF-16 units.
enum PersonName {
    static let maximumLength = 80

    static func validated(_ raw: String) throws -> String {
        guard let name = try validatedOptional(raw) else { throw PersonNameError.empty }
        return name
    }

    /// A blank name is `nil`, which clears a person's name.
    static func validatedOptional(_ raw: String) throws -> String? {
        let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return nil }
        guard trimmed.utf16.count <= maximumLength else { throw PersonNameError.tooLong }
        return trimmed
    }
}

enum PersonNameError: Error, Equatable, LocalizedError, Sendable {
    case empty
    case tooLong

    var errorDescription: String? {
        switch self {
        case .empty: "Enter a name."
        case .tooLong: "Names can be at most \(PersonName.maximumLength) characters."
        }
    }
}

/// Client-side mirror of the merge rule: 1-50 distinct positive source ids, none the target.
enum PeopleMerge {
    static let maximumSources = 50

    static func isValid(targetId: Int, sourceIds: [Int]) -> Bool {
        targetId > 0
            && (1...maximumSources).contains(sourceIds.count)
            && Set(sourceIds).count == sourceIds.count
            && !sourceIds.contains(targetId)
            && sourceIds.allSatisfy { $0 > 0 }
    }
}

/// `GET /api/faces/{id}/crop?size=`: a square WebP around one face, a binary route outside
/// `/api/v1`. Crops are immutable per face id.
enum FaceCrop {
    static let defaultSize = 256

    static func url(baseURL: URL, faceID: Int, size: Int = defaultSize) -> URL {
        var url = baseURL
            .appendingPathComponent("api")
            .appendingPathComponent("faces")
            .appendingPathComponent(String(faceID))
            .appendingPathComponent("crop")
        url.append(queryItems: [URLQueryItem(name: "size", value: String(size))])
        return url
    }
}

struct APIErrorEnvelope: Codable, Equatable, Sendable {
    struct Detail: Codable, Equatable, Sendable {
        let code: String
        let message: String
    }

    let error: Detail
}

enum PhotoBrainAPIError: Error, Equatable, LocalizedError, Sendable {
    case invalidConfiguration(String)
    case invalidRequest
    case invalidResponse
    case transport(String)
    case server(status: Int, code: String, message: String)
    case decoding(String)
    /// `409 DUPLICATE_GROUP_CHANGED`: the group's membership changed since it was listed.
    case duplicateGroupChanged
    /// `503 EXPORT_BUSY`: the server's render queue is full; `retryAfter` is the `Retry-After`
    /// delay in seconds when the server sent one.
    case exportBusy(retryAfter: Int?)

    var errorDescription: String? {
        switch self {
        case let .invalidConfiguration(message): message
        case .invalidRequest: "The request could not be created."
        case .invalidResponse: "The server returned an invalid response."
        case let .transport(message): message
        case let .server(_, code, message):
            switch code {
            case "COLLECTION_NAME_TAKEN": "A collection with that name already exists."
            case "COLLECTION_NOT_FOUND": "This collection no longer exists."
            case "SMART_ALBUM_NAME_TAKEN": "A smart album with that name already exists."
            case "SMART_ALBUM_NOT_FOUND": "This smart album no longer exists."
            case "PERSON_NOT_FOUND": "This person no longer exists."
            case "FACE_NOT_FOUND": "This face is no longer in the photo."
            case "SOURCE_MISSING": "The original file is no longer in the photo library on the server."
            case "EXPORT_FAILED": "This photo couldn’t be converted for sharing."
            default: message
            }
        case .decoding: "PhotoBrain could not read the server response."
        case .duplicateGroupChanged: "This group changed since it was loaded. Duplicates were refreshed."
        case let .exportBusy(retryAfter):
            if let retryAfter, retryAfter > 0 {
                retryAfter == 1
                    ? "The server is busy preparing other exports. Try again in 1 second."
                    : "The server is busy preparing other exports. Try again in \(retryAfter) seconds."
            } else {
                "The server is busy preparing other exports. Try again in a moment."
            }
        }
    }

    var code: String? {
        switch self {
        case let .server(_, code, _): code
        case .exportBusy: "EXPORT_BUSY"
        default: nil
        }
    }

    /// The request may succeed if repeated unchanged: a lost connection or a busy server.
    var isRetryable: Bool {
        switch self {
        case .transport, .exportBusy: true
        default: false
        }
    }

    var isDefinitiveScanRejection: Bool {
        if case .server = self { return true }
        return false
    }
}
