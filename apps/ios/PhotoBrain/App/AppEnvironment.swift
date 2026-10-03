import Foundation
import SwiftUI

enum BuildLane: String, Sendable {
    case debug = "Debug"
    case preview = "Preview"
    case production = "Production"

    static var current: BuildLane {
        #if DEBUG
        .debug
        #elseif PREVIEW
        .preview
        #else
        .production
        #endif
    }
}

struct AppEnvironment: Sendable {
    let lane: BuildLane
    let apiURL: URL
    let api: any PhotoBrainAPI

    init(
        bundle: Bundle = .main,
        lane: BuildLane = .current,
        session: URLSession? = nil
    ) throws {
        guard let raw = bundle.object(forInfoDictionaryKey: "PhotoBrainAPIURL") as? String,
              !raw.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
              let url = URL(string: raw),
              url.host != nil else {
            throw PhotoBrainAPIError.invalidConfiguration(
                "PhotoBrainAPIURL must be explicitly configured for \(lane.rawValue)."
            )
        }
        try Self.validate(url: url, lane: lane)
        self.lane = lane
        apiURL = url
        api = APIClient(baseURL: url, session: session)
    }

    init(lane: BuildLane, apiURL: URL, api: any PhotoBrainAPI) throws {
        try Self.validate(url: apiURL, lane: lane)
        self.lane = lane
        self.apiURL = apiURL
        self.api = api
    }

    static func validate(url: URL, lane: BuildLane) throws {
        guard url.user == nil,
              url.password == nil,
              url.query == nil,
              url.fragment == nil,
              url.path.isEmpty || url.path == "/" else {
            throw PhotoBrainAPIError.invalidConfiguration("The API URL must be an origin without credentials, path, or query data.")
        }
        guard lane != .debug else {
            guard url.scheme == "http" || url.scheme == "https" else {
                throw PhotoBrainAPIError.invalidConfiguration("Debug API URL must use HTTP or HTTPS.")
            }
            return
        }
        guard url.scheme == "https", let host = url.host?.lowercased(), !isLocal(host: host) else {
            throw PhotoBrainAPIError.invalidConfiguration(
                "Preview and Production require a non-local HTTPS API origin."
            )
        }
    }

    private static func isLocal(host: String) -> Bool {
        if host == "localhost"
            || host == "0.0.0.0"
            || host == "::1"
            || host.hasPrefix("127.")
            || host.hasPrefix("10.")
            || host.hasPrefix("192.168.")
            || host.hasPrefix("169.254.")
            || host.hasSuffix(".local")
            || !host.contains(".") {
            return true
        }
        let parts = host.split(separator: ".").compactMap { Int($0) }
        return parts.count == 4 && parts[0] == 172 && (16...31).contains(parts[1])
    }
}

enum ThemePreference: String, Codable, CaseIterable, Identifiable, Sendable {
    case light
    case dark
    case system

    var id: Self { self }
    var title: String { rawValue.capitalized }

    var colorScheme: ColorScheme? {
        switch self {
        case .light: .light
        case .dark: .dark
        case .system: nil
        }
    }
}

struct MigrationEnvelope: Codable, Equatable, Sendable {
    let schemaVersion: Int
    let theme: ThemePreference
    let activeScanId: String?

    init(schemaVersion: Int = 1, theme: ThemePreference, activeScanId: String?) {
        self.schemaVersion = schemaVersion
        self.theme = theme
        self.activeScanId = activeScanId
    }

    private enum CodingKeys: String, CodingKey {
        case schemaVersion
        case theme
        case activeScanId
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        schemaVersion = try container.decode(Int.self, forKey: .schemaVersion)
        guard schemaVersion == 1 else {
            throw DecodingError.dataCorruptedError(
                forKey: .schemaVersion,
                in: container,
                debugDescription: "Unsupported migration schema"
            )
        }
        theme = try container.decode(ThemePreference.self, forKey: .theme)
        guard container.contains(.activeScanId) else {
            throw DecodingError.keyNotFound(
                CodingKeys.activeScanId,
                .init(codingPath: decoder.codingPath, debugDescription: "Missing activeScanId")
            )
        }
        let decodedID = try container.decodeIfPresent(String.self, forKey: .activeScanId)
        if let decodedID {
            guard UUID(uuidString: decodedID) != nil else {
                throw DecodingError.dataCorruptedError(
                    forKey: .activeScanId,
                    in: container,
                    debugDescription: "activeScanId is not a UUID"
                )
            }
            activeScanId = decodedID.lowercased()
        } else {
            activeScanId = nil
        }
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(schemaVersion, forKey: .schemaVersion)
        try container.encode(theme, forKey: .theme)
        if let activeScanId {
            try container.encode(activeScanId, forKey: .activeScanId)
        } else {
            try container.encodeNil(forKey: .activeScanId)
        }
    }
}

struct MigrationImport: Equatable, Sendable {
    let theme: ThemePreference
    let activeScanID: String?
}

actor MigrationStore {
    static let envelopeKey = "com.photobrain.migration.v1"

    private enum EnvelopeState {
        case absent
        case valid(MigrationEnvelope)
        case invalid
    }

    private let defaults: UserDefaults
    private let encoder = JSONEncoder()
    private let decoder = JSONDecoder()

    init(defaults: UserDefaults = .standard) {
        self.defaults = defaults
        encoder.outputFormatting = [.sortedKeys]
    }

    func importSchemaOne() -> MigrationImport {
        switch envelopeState() {
        case let .valid(envelope):
            return MigrationImport(theme: envelope.theme, activeScanID: envelope.activeScanId)
        case .absent:
            let envelope = MigrationEnvelope(theme: .system, activeScanId: nil)
            write(envelope)
            return MigrationImport(theme: .system, activeScanID: nil)
        case .invalid:
            return MigrationImport(theme: .system, activeScanID: nil)
        }
    }

    func setTheme(_ theme: ThemePreference) {
        mutateEnvelope { envelope in
            MigrationEnvelope(theme: theme, activeScanId: envelope.activeScanId)
        }
    }

    func setActiveScanID(_ id: String?) {
        let normalizedID: String?
        if let id {
            guard UUID(uuidString: id) != nil else { return }
            normalizedID = id.lowercased()
        } else {
            normalizedID = nil
        }
        mutateEnvelope { envelope in
            MigrationEnvelope(theme: envelope.theme, activeScanId: normalizedID)
        }
    }

    private func mutateEnvelope(
        _ mutation: (MigrationEnvelope) -> MigrationEnvelope
    ) {
        switch envelopeState() {
        case let .valid(envelope):
            write(mutation(envelope))
        case .absent:
            write(mutation(MigrationEnvelope(theme: .system, activeScanId: nil)))
        case .invalid:
            break
        }
    }

    private func envelopeState() -> EnvelopeState {
        guard let value = defaults.object(forKey: Self.envelopeKey) else {
            return .absent
        }
        guard let data = value as? Data,
              let envelope = try? decoder.decode(MigrationEnvelope.self, from: data) else {
            return .invalid
        }
        return .valid(envelope)
    }

    private func write(_ envelope: MigrationEnvelope) {
        guard let data = try? encoder.encode(envelope) else { return }
        defaults.set(data, forKey: Self.envelopeKey)
    }
}

@MainActor
final class ThemeController: ObservableObject {
    @Published private(set) var preference: ThemePreference
    private let migration: MigrationStore

    init(preference: ThemePreference, migration: MigrationStore) {
        self.preference = preference
        self.migration = migration
    }

    func select(_ preference: ThemePreference) {
        self.preference = preference
        Task { await migration.setTheme(preference) }
    }
}
