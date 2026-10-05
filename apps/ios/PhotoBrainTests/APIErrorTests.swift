import XCTest
@testable import PhotoBrain

final class APIErrorTests: XCTestCase {
    func testNestedTransportErrorDecodesStableCodeAndMessage() throws {
        let data = #"{"error":{"code":"NATIVE_SCAN_DISABLED","message":"Native scanning is disabled"}}"#.data(using: .utf8)!
        let envelope = try JSONDecoder().decode(APIErrorEnvelope.self, from: data)
        XCTAssertEqual(envelope.error.code, "NATIVE_SCAN_DISABLED")
        XCTAssertEqual(envelope.error.message, "Native scanning is disabled")

        let error = PhotoBrainAPIError.server(
            status: 503,
            code: envelope.error.code,
            message: envelope.error.message
        )
        XCTAssertTrue(error.isDefinitiveScanRejection)
        XCTAssertEqual(error.errorDescription, "Native scanning is disabled")
    }

    func testOnlyLostTransportResponseIsAmbiguous() {
        XCTAssertFalse(PhotoBrainAPIError.transport("Timed out").isDefinitiveScanRejection)
        XCTAssertTrue(
            PhotoBrainAPIError.server(status: 502, code: "SCAN_DISPATCH_FAILED", message: "Dispatch failed")
                .isDefinitiveScanRejection
        )
    }

    func testEnvironmentRejectsLocalOrCleartextDistributedOrigins() {
        XCTAssertThrowsError(try AppEnvironment.validate(url: URL(string: "http://localhost:3000")!, lane: .preview))
        XCTAssertThrowsError(try AppEnvironment.validate(url: URL(string: "http://example.com")!, lane: .production))
        XCTAssertNoThrow(try AppEnvironment.validate(url: URL(string: "https://example.com")!, lane: .production))
        XCTAssertNoThrow(try AppEnvironment.validate(url: URL(string: "http://localhost:3000")!, lane: .debug))
    }

    func testLaunchEnvironmentOverridesAPIOriginOnlyInDebug() {
        let environment = ["PHOTOBRAIN_API_URL": "http://127.0.0.1:61234"]
        XCTAssertEqual(
            AppEnvironment.configuredAPIURL(bundle: .main, lane: .debug, environment: environment),
            "http://127.0.0.1:61234"
        )
        for lane in [BuildLane.preview, .production] {
            XCTAssertEqual(
                AppEnvironment.configuredAPIURL(bundle: .main, lane: lane, environment: environment),
                Bundle.main.object(forInfoDictionaryKey: "PhotoBrainAPIURL") as? String
            )
        }
    }
}
