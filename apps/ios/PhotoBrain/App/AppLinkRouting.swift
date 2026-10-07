import Foundation
import Combine

enum AppLinkRoute: String, Hashable, Identifiable, Sendable {
    case library
    case collections
    case people
    case search
    case settings
    case about

    var id: String { rawValue }
}

enum AppPresentedRoute: String, Hashable, Identifiable, Sendable {
    case settings
    case about

    var id: String { rawValue }
}

struct AppLinkNavigationState: Equatable, Sendable {
    var selectedTab: AppTab = .library
    var presentedRoute: AppPresentedRoute?

    mutating func apply(_ route: AppLinkRoute) {
        switch route {
        case .library:
            selectedTab = .library
            presentedRoute = nil
        case .collections:
            selectedTab = .collections
            presentedRoute = nil
        case .people:
            selectedTab = .people
            presentedRoute = nil
        case .search:
            selectedTab = .search
            presentedRoute = nil
        case .settings:
            presentedRoute = .settings
        case .about:
            presentedRoute = .about
        }
    }
}

enum AppLinkParser {
    static func expectedScheme(for lane: BuildLane) -> String {
        switch lane {
        case .debug: "photobrain-debug"
        case .preview: "photobrain-preview"
        case .production: "photobrain"
        }
    }

    static func parse(_ url: URL, lane: BuildLane) -> AppLinkRoute? {
        guard url.scheme?.lowercased() == expectedScheme(for: lane),
              url.user == nil,
              url.password == nil,
              url.port == nil,
              url.query == nil,
              url.fragment == nil else { return nil }

        var segments: [String] = []
        if let host = url.host, !host.isEmpty {
            segments.append(host)
        }
        segments.append(contentsOf: url.pathComponents.filter { $0 != "/" && !$0.isEmpty })
        guard segments.count <= 1 else { return nil }
        let route = segments.first?
            .removingPercentEncoding?
            .trimmingCharacters(in: .whitespacesAndNewlines)
            .lowercased()

        switch route {
        case nil, "", "root", "library": return .library
        case "collections", "albums": return .collections
        case "people": return .people
        case "search": return .search
        case "preferences", "settings": return .settings
        case "about": return .about
        default: return nil
        }
    }
}

@MainActor
final class AppLinkRouter: ObservableObject {
    @Published private(set) var pendingRoute: AppLinkRoute?
    private let lane: BuildLane

    init(lane: BuildLane) {
        self.lane = lane
    }

    func open(_ url: URL) {
        guard let route = AppLinkParser.parse(url, lane: lane) else { return }
        pendingRoute = route
    }

    func takePendingRoute() -> AppLinkRoute? {
        defer { pendingRoute = nil }
        return pendingRoute
    }
}
