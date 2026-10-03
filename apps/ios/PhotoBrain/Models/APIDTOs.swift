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
        case let .server(_, _, message): message
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
