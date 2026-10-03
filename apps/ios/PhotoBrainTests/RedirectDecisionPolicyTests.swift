import XCTest
@testable import PhotoBrain

final class RedirectDecisionPolicyTests: XCTestCase {
    private let thumbnail = URL(string: "https://photos.example.invalid/api/photos/42/thumbnail/medium")!
    private let original = URL(string: "https://photos.example.invalid/api/photos/42/file")!

    func testStandardPhotoThumbnailToOriginalRedirectIsRejected() {
        XCTAssertEqual(
            RedirectDecisionPolicy.decision(
                from: thumbnail,
                to: original,
                metadata: PhotoMediaMetadata(isConvertedRAW: false)
            ),
            .cancel
        )
    }

    func testConvertedRAWThumbnailToOriginalRedirectIsAllowedWhenMetadataConfirmsIt() {
        XCTAssertEqual(
            RedirectDecisionPolicy.decision(
                from: thumbnail,
                to: original,
                metadata: PhotoMediaMetadata(isConvertedRAW: true)
            ),
            .allow
        )
    }

    func testMissingMetadataCrossHostAndUnrelatedRedirectsAreRejected() {
        XCTAssertEqual(
            RedirectDecisionPolicy.decision(from: thumbnail, to: original, metadata: nil),
            .cancel
        )
        XCTAssertEqual(
            RedirectDecisionPolicy.decision(
                from: thumbnail,
                to: URL(string: "https://other.example.invalid/api/photos/42/file")!,
                metadata: PhotoMediaMetadata(isConvertedRAW: true)
            ),
            .cancel
        )
        XCTAssertEqual(
            RedirectDecisionPolicy.decision(
                from: thumbnail,
                to: URL(string: "https://photos.example.invalid/login")!,
                metadata: PhotoMediaMetadata(isConvertedRAW: true)
            ),
            .cancel
        )
    }

    func testCleartextRedirectsAreAllowedOnlyForDebugLoopbackOrigins() {
        let localThumbnail = URL(string: "http://localhost:3000/api/photos/42/thumbnail/large")!
        let localOriginal = URL(string: "http://localhost:3000/api/photos/42/file")!
        XCTAssertEqual(
            RedirectDecisionPolicy.decision(
                from: localThumbnail,
                to: localOriginal,
                metadata: PhotoMediaMetadata(isConvertedRAW: true)
            ),
            .allow
        )
        XCTAssertEqual(
            RedirectDecisionPolicy.decision(
                from: URL(string: "http://photos.example.invalid/api/photos/42/thumbnail/large")!,
                to: URL(string: "http://photos.example.invalid/api/photos/42/file")!,
                metadata: PhotoMediaMetadata(isConvertedRAW: true)
            ),
            .cancel
        )
    }

    func testDiskCacheStoresRedirectedBytesUnderLogicalVersionedURLAndRevalidatesWhenStale() throws {
        let logical = URL(string: "https://photos.example.invalid/api/photos/42/thumbnail/large?v=100")!
        let redirectTarget = URL(string: "https://photos.example.invalid/api/photos/42/file")!
        let now = Date(timeIntervalSince1970: 10_000)
        let transport = try XCTUnwrap(
            HTTPURLResponse(
                url: redirectTarget,
                statusCode: 200,
                httpVersion: "HTTP/1.1",
                headerFields: [
                    "Cache-Control": "max-age=60",
                    "ETag": "\"generation-100\"",
                ]
            )
        )
        let stored = try XCTUnwrap(
            LogicalImageDiskCachePolicy.responseForStorage(
                logicalURL: logical,
                transportResponse: transport,
                now: now
            )
        )

        XCTAssertEqual(stored.url, logical)
        XCTAssertTrue(LogicalImageDiskCachePolicy.isFresh(stored, now: now.addingTimeInterval(59)))
        XCTAssertFalse(LogicalImageDiskCachePolicy.isFresh(stored, now: now.addingTimeInterval(60)))
        XCTAssertEqual(
            LogicalImageDiskCachePolicy.revalidationHeaders(stored)["If-None-Match"],
            "\"generation-100\""
        )
        XCTAssertNotEqual(
            stored.url,
            URL(string: "https://photos.example.invalid/api/photos/42/thumbnail/large?v=101")
        )
    }

    func testNoStoreResponseIsNeverAdmittedToLogicalDiskCache() {
        let response = HTTPURLResponse(
            url: original,
            statusCode: 200,
            httpVersion: "HTTP/1.1",
            headerFields: ["Cache-Control": "no-store, max-age=300"]
        )!
        XCTAssertNil(
            LogicalImageDiskCachePolicy.responseForStorage(
                logicalURL: thumbnail,
                transportResponse: response,
                now: Date()
            )
        )
    }
}
