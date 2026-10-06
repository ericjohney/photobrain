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
        guard let raw = Self.configuredAPIURL(bundle: bundle, lane: lane),
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

    /// The Info.plist origin, except that Debug builds honor a
    /// `PHOTOBRAIN_API_URL` launch-environment override so UI tests can target
    /// their fixture server's ephemeral port. Release lanes never read it.
    static func configuredAPIURL(
        bundle: Bundle,
        lane: BuildLane,
        environment: [String: String] = ProcessInfo.processInfo.environment
    ) -> String? {
        if lane == .debug, let override = environment["PHOTOBRAIN_API_URL"] {
            return override
        }
        return bundle.object(forInfoDictionaryKey: "PhotoBrainAPIURL") as? String
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

/// Device-local preferences that survive relaunch: the theme and the scan to resume tracking.
actor PreferencesStore {
    static let themeKey = "com.photobrain.theme"
    static let activeScanIDKey = "com.photobrain.activeScanId"

    private let defaults: UserDefaults

    init(defaults: UserDefaults = .standard) {
        self.defaults = defaults
    }

    var theme: ThemePreference {
        defaults.string(forKey: Self.themeKey).flatMap(ThemePreference.init(rawValue:)) ?? .system
    }

    /// The saved non-terminal scan, lowercased; nil when absent or not a UUID.
    var activeScanID: String? {
        guard let id = defaults.string(forKey: Self.activeScanIDKey),
              UUID(uuidString: id) != nil else { return nil }
        return id.lowercased()
    }

    func setTheme(_ theme: ThemePreference) {
        defaults.set(theme.rawValue, forKey: Self.themeKey)
    }

    func setActiveScanID(_ id: String?) {
        guard let id else {
            defaults.removeObject(forKey: Self.activeScanIDKey)
            return
        }
        guard UUID(uuidString: id) != nil else { return }
        defaults.set(id.lowercased(), forKey: Self.activeScanIDKey)
    }
}

@MainActor
final class ThemeController: ObservableObject {
    @Published private(set) var preference: ThemePreference
    private let preferences: PreferencesStore

    init(preference: ThemePreference, preferences: PreferencesStore) {
        self.preference = preference
        self.preferences = preferences
    }

    func select(_ preference: ThemePreference) {
        self.preference = preference
        Task { await preferences.setTheme(preference) }
    }
}
