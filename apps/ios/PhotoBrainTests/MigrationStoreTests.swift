import XCTest
@testable import PhotoBrain

final class MigrationStoreTests: XCTestCase {
    func testImportsSchemaOneAndPreservesUnownedFieldAcrossSerializedWrites() async throws {
        let suite = "MigrationStoreTests.\(UUID().uuidString)"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }
        let id = "AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE"
        defaults.set(
            #"{"schemaVersion":1,"theme":"dark","activeScanId":"AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE"}"#.data(using: .utf8),
            forKey: MigrationStore.envelopeKey
        )

        let store = MigrationStore(defaults: defaults)
        let imported = await store.importSchemaOne()
        XCTAssertEqual(imported.theme, .dark)
        XCTAssertEqual(imported.activeScanID, id.lowercased())

        await store.setTheme(.light)
        var envelope = try decodeEnvelope(defaults)
        XCTAssertEqual(envelope.theme, .light)
        XCTAssertEqual(envelope.activeScanId, id.lowercased())

        await store.setActiveScanID(nil)
        envelope = try decodeEnvelope(defaults)
        XCTAssertEqual(envelope.theme, .light)
        XCTAssertNil(envelope.activeScanId)
        let afterClear = await store.importSchemaOne()
        XCTAssertEqual(afterClear, MigrationImport(theme: .light, activeScanID: nil))
    }

    func testAbsentEnvelopeIsSeededAndMalformedEnvelopeIsNeverOverwritten() async throws {
        let suite = "MigrationStoreTests.\(UUID().uuidString)"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }
        let store = MigrationStore(defaults: defaults)

        let seeded = await store.importSchemaOne()
        XCTAssertEqual(seeded, MigrationImport(theme: .system, activeScanID: nil))
        XCTAssertEqual(try decodeEnvelope(defaults), MigrationEnvelope(theme: .system, activeScanId: nil))

        let malformed = #"{"schemaVersion":2,"theme":"dark","activeScanId":"not-a-uuid"}"#.data(using: .utf8)!
        defaults.set(malformed, forKey: MigrationStore.envelopeKey)
        let rejected = await store.importSchemaOne()
        XCTAssertEqual(rejected, MigrationImport(theme: .system, activeScanID: nil))
        await store.setTheme(.dark)
        await store.setActiveScanID("AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE")
        XCTAssertEqual(defaults.data(forKey: MigrationStore.envelopeKey), malformed)
    }

    private func decodeEnvelope(_ defaults: UserDefaults) throws -> MigrationEnvelope {
        let data = try XCTUnwrap(defaults.data(forKey: MigrationStore.envelopeKey))
        return try JSONDecoder().decode(MigrationEnvelope.self, from: data)
    }
}
