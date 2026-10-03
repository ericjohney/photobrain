import XCTest
@testable import PhotoBrain

final class APIModelTests: XCTestCase {
    func testPhotoDatesDecodeAsISOAndPrivateIdentityKeysNeverEncode() throws {
        let json = #"{"id":7,"path":"synthetic/photo.jpg","name":"photo.jpg","size":1024,"createdAt":"2024-01-02T03:04:05.000Z","modifiedAt":"2024-01-02T03:04:06Z","width":4000,"height":3000,"mimeType":"image/jpeg","isRaw":false,"rawFormat":null,"rawStatus":null,"rawError":null,"thumbnailStatus":"completed","thumbnailUpdatedAt":"2024-01-02T03:04:07.123Z","embeddingStatus":"completed","phashStatus":"completed","exif":null,"sourceRoot":"private","sourceFingerprint":"private","mediaVersion":"private","thumbnailKey":"private","thumbnailRoot":"private","thumbnailFingerprint":"private"}"#.data(using: .utf8)!
        let photo = try APIModelCoding.decoder().decode(PhotoDTO.self, from: json)
        XCTAssertEqual(photo.id, 7)
        XCTAssertEqual(photo.createdAt.timeIntervalSince1970, 1_704_164_645, accuracy: 0.001)
        XCTAssertNotNil(photo.thumbnailUpdatedAt)

        let encoded = String(data: try APIModelCoding.encoder().encode(photo), encoding: .utf8)!
        for key in ["sourceRoot", "sourceFingerprint", "mediaVersion", "thumbnailKey", "thumbnailRoot", "thumbnailFingerprint"] {
            XCTAssertFalse(encoded.contains(key))
        }
    }

    func testScanTerminalAndProgressSemantics() {
        let running = TestModels.scan(
            id: "00000000-0000-0000-0000-000000000001",
            current: 5,
            updatedAt: Date()
        )
        XCTAssertFalse(running.isTerminal)
        XCTAssertEqual(running.fractionCompleted, 0.5)

        let completed = TestModels.scan(
            id: running.id,
            phase: .completed,
            current: 10,
            updatedAt: Date()
        )
        XCTAssertTrue(completed.isTerminal)
        XCTAssertFalse(completed.isFailed)
    }

    func testScanEnumsRoundTripAndRejectUnknownWireStates() throws {
        XCTAssertEqual(
            ScanPhase.allCases.map(\.rawValue),
            [
                "queued",
                "discovering",
                "processing",
                "scan-complete",
                "embedding",
                "completed",
                "failed",
            ]
        )
        XCTAssertEqual(
            ScanStatus.allCases.map(\.rawValue),
            ["queued", "running", "completed", "failed"]
        )

        for phase in ScanPhase.allCases {
            for status in ScanStatus.allCases {
                let data = scanJSON(phase: phase.rawValue, status: status.rawValue)
                let decoded = try APIModelCoding.decoder().decode(ScanDTO.self, from: data)
                XCTAssertEqual(decoded.phase, phase)
                XCTAssertEqual(decoded.status, status)

                let encoded = try APIModelCoding.encoder().encode(decoded)
                let roundTripped = try APIModelCoding.decoder().decode(ScanDTO.self, from: encoded)
                XCTAssertEqual(roundTripped.phase, phase)
                XCTAssertEqual(roundTripped.status, status)
            }
        }

        XCTAssertThrowsError(
            try APIModelCoding.decoder().decode(
                ScanDTO.self,
                from: scanJSON(phase: "unknown", status: ScanStatus.running.rawValue)
            )
        )
        XCTAssertThrowsError(
            try APIModelCoding.decoder().decode(
                ScanDTO.self,
                from: scanJSON(phase: ScanPhase.processing.rawValue, status: "unknown")
            )
        )
    }

    func testScanDomainFailureDecodesWithoutJobID() throws {
        let data = #"{"success":false,"error":"The scan could not be started"}"#.data(using: .utf8)!
        let response = try APIModelCoding.decoder().decode(StartScanResponseDTO.self, from: data)
        XCTAssertFalse(response.success)
        XCTAssertNil(response.jobId)
        XCTAssertEqual(response.error, "The scan could not be started")
    }
    private func scanJSON(phase: String, status: String) -> Data {
        Data(
            """
            {"id":"00000000-0000-4000-8000-000000000001","phase":"\(phase)","current":1,"total":10,"status":"\(status)","error":null,"createdAt":"2026-09-21T00:00:00Z","updatedAt":"2026-09-21T00:00:01Z"}
            """.utf8
        )
    }
}
