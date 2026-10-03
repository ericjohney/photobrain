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
            default: message
            }
        case .decoding: "PhotoBrain could not read the server response."
        }
    }

    var code: String? {
        guard case let .server(_, code, _) = self else { return nil }
        return code
    }

    var isDefinitiveScanRejection: Bool {
        if case .server = self { return true }
        return false
    }
}
