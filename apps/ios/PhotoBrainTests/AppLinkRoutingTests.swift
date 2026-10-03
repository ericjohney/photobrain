import XCTest
@testable import PhotoBrain

@MainActor
final class AppLinkRoutingTests: XCTestCase {
    func testProductionRoutesExpoCompatibleCustomSchemePaths() throws {
        let cases: [(String, AppLinkRoute)] = [
            ("photobrain:///", .library),
            ("photobrain://library", .library),
            ("photobrain:///collections", .collections),
            ("photobrain://search", .search),
            ("photobrain://preferences", .settings),
            ("photobrain:///settings", .settings),
            ("photobrain://about", .about),
        ]

        for (value, expected) in cases {
            let url = try XCTUnwrap(URL(string: value))
            XCTAssertEqual(AppLinkParser.parse(url, lane: .production), expected, value)
        }
    }

    func testLaneAndUnknownRouteRejectionHasNoNavigationSideEffect() throws {
        let router = AppLinkRouter(lane: .preview)
        router.open(try XCTUnwrap(URL(string: "photobrain-preview://search")))
        XCTAssertEqual(router.pendingRoute, .search)

        router.open(try XCTUnwrap(URL(string: "photobrain://collections")))
        router.open(try XCTUnwrap(URL(string: "photobrain-preview://unknown")))
        router.open(try XCTUnwrap(URL(string: "photobrain-preview://about?unexpected=1")))
        XCTAssertEqual(router.pendingRoute, .search)
    }

    func testPendingColdRouteIsConsumedOnceAfterBootstrap() throws {
        let router = AppLinkRouter(lane: .production)
        router.open(try XCTUnwrap(URL(string: "photobrain://about")))

        XCTAssertEqual(router.takePendingRoute(), .about)
        XCTAssertNil(router.takePendingRoute())
    }

    func testNavigationStateRoutesTabsAndExistingModalDestinations() {
        var state = AppLinkNavigationState()
        state.apply(.search)
        XCTAssertEqual(state.selectedTab, .search)
        XCTAssertNil(state.presentedRoute)

        state.apply(.settings)
        XCTAssertEqual(state.selectedTab, .search)
        XCTAssertEqual(state.presentedRoute, .settings)

        state.apply(.about)
        XCTAssertEqual(state.presentedRoute, .about)

        state.apply(.collections)
        XCTAssertEqual(state.selectedTab, .collections)
        XCTAssertNil(state.presentedRoute)
    }
}
