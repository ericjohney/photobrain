import XCTest
@testable import PhotoBrain

final class PreferencesStoreTests: XCTestCase {
    func testThemeAndActiveScanSurviveANewStoreAndClearRemovesTheScan() async throws {
        let suite = "PreferencesStoreTests.\(UUID().uuidString)"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }

        let store = PreferencesStore(defaults: defaults)
        await store.setTheme(.dark)
        await store.setActiveScanID("AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE")

        let relaunched = PreferencesStore(defaults: defaults)
        let theme = await relaunched.theme
        let activeScanID = await relaunched.activeScanID
        XCTAssertEqual(theme, .dark)
        XCTAssertEqual(activeScanID, "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee")

        await relaunched.setActiveScanID(nil)
        let cleared = await relaunched.activeScanID
        XCTAssertNil(cleared)
        XCTAssertNil(defaults.object(forKey: PreferencesStore.activeScanIDKey))
    }

    func testUnrecognizedStoredValuesFallBackAndNonUUIDWritesAreIgnored() async throws {
        let suite = "PreferencesStoreTests.\(UUID().uuidString)"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }
        defaults.set("sepia", forKey: PreferencesStore.themeKey)
        defaults.set("not-a-uuid", forKey: PreferencesStore.activeScanIDKey)

        let store = PreferencesStore(defaults: defaults)
        let theme = await store.theme
        let activeScanID = await store.activeScanID
        XCTAssertEqual(theme, .system)
        XCTAssertNil(activeScanID)

        let saved = "11111111-2222-3333-4444-555555555555"
        await store.setActiveScanID(saved)
        await store.setActiveScanID("still-not-a-uuid")
        let retained = await store.activeScanID
        XCTAssertEqual(retained, saved)
    }
}
