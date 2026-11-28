import UIKit
import XCTest
@testable import PhotoBrain

@MainActor
final class DevelopedRawTests: XCTestCase {
    private let base = URL(string: "https://photos.example.invalid")!
    private var suiteName: String!
    private var cache: SmartPreviewCache!

    override func setUp() {
        super.setUp()
        suiteName = "DevelopedRawTests.\(UUID().uuidString)"
        cache = SmartPreviewCache(root: FileManager.default.temporaryDirectory.appendingPathComponent(suiteName))
    }

    override func tearDown() {
        try? FileManager.default.removeItem(at: FileManager.default.temporaryDirectory.appendingPathComponent(suiteName))
        super.tearDown()
    }

    private func record(_ dto: PhotoDTO) -> PhotoRecord {
        PhotoRecord(dto: dto, apiBaseURL: base)
    }

    private var raw: PhotoRecord {
        record(TestModels.photo(id: 2, name: "DSC_0002.ARW", isRaw: true, rawFormat: "ARW"))
    }

    private static func jpeg(width: Int = 3, height: Int = 2) -> Data {
        let format = UIGraphicsImageRendererFormat()
        format.scale = 1
        return UIGraphicsImageRenderer(size: CGSize(width: width, height: height), format: format)
            .jpegData(withCompressionQuality: 0.9) { context in
                UIColor.gray.setFill()
                context.fill(CGRect(x: 0, y: 0, width: width, height: height))
            }
    }

    private func waitFor(_ store: LoupeDevelopedStore, _ predicate: @escaping (LoupeRendition) -> Bool) async {
        for _ in 0..<200 {
            if predicate(store.rendition) { return }
            try? await Task.sleep(for: .milliseconds(10))
        }
        XCTFail("Timed out; rendition is \(store.rendition)")
    }

    func testDevelopableRawIDCoversRawsAndPairsOnly() {
        XCTAssertEqual(LoupeRendition.developableRawID(for: raw), 2)
        let pairedJPEG = record(TestModels.photo(id: 8, name: "forest.jpg", pairedPhotoId: 13, pairedFormat: "ARW"))
        XCTAssertEqual(LoupeRendition.developableRawID(for: pairedJPEG), 13)
        XCTAssertNil(LoupeRendition.developableRawID(for: record(TestModels.photo(id: 1))))
        XCTAssertNil(LoupeRendition.developableRawID(for: nil))
    }

    func testSamePhotoReloadsWhenBackgroundPreviewGenerationChanges() async {
        let api = TestAPI()
        await api.setDevelopedResults([
            .success(DevelopedRawImage(data: Self.jpeg(), width: 1600, height: 1066)),
            .success(DevelopedRawImage(data: Self.jpeg(), width: 2048, height: 1365)),
        ])
        let store = LoupeDevelopedStore(api: api, cache: cache)
        store.show(raw)
        await waitFor(store) { $0 == .developed(width: 1600, height: 1066) }
        let changed = record(TestModels.photo(id: 2, name: "DSC_0002.ARW", isRaw: true, rawFormat: "ARW", thumbnailUpdatedAt: Date(timeIntervalSince1970: 1_800_000_000)))
        store.show(changed)
        await waitFor(store) { $0 == .developed(width: 2048, height: 1365) }
        let requests = await api.developedRequests
        XCTAssertEqual(requests, [2, 2])
    }

    func testStackAutomaticallyLoadsItsRAWPartnerOncePerVisit() async {
        let api = TestAPI()
        await api.setDevelopedResults([.success(DevelopedRawImage(data: Self.jpeg(), width: 2048, height: 1365))])
        let store = LoupeDevelopedStore(api: api, cache: cache)
        let stack = record(TestModels.photo(id: 8, name: "forest.jpg", pairedPhotoId: 13, pairedFormat: "ARW"))
        store.show(stack)
        XCTAssertEqual(store.rendition, .developing)
        await waitFor(store) { $0 == .developed(width: 2048, height: 1365) }
        store.show(stack)
        let requests = await api.developedRequests
        XCTAssertEqual(requests, [13])
        XCTAssertNotNil(store.images[8])
        store.show(record(TestModels.photo(id: 1)))
        XCTAssertEqual(store.rendition, .embedded)
        XCTAssertTrue(store.images.isEmpty)
    }

    func testFallsBackToDecodedSizeWithoutHeaders() async {
        let api = TestAPI()
        await api.setDevelopedResults([.success(DevelopedRawImage(data: Self.jpeg(width: 5, height: 4), width: nil, height: nil))])
        let store = LoupeDevelopedStore(api: api, busyDelay: .zero, cache: cache)
        store.show(raw)
        await waitFor(store) { $0 == .developed(width: 5, height: 4) }
    }

    func testUnsupportedCameraKeepsPreviewWithReason() async {
        let api = TestAPI()
        await api.setDevelopedResults([
            .failure(.server(status: 422, code: "DEVELOP_UNSUPPORTED", message: "not a supported RAW file")),
        ])
        let store = LoupeDevelopedStore(api: api, busyDelay: .zero, cache: cache)
        store.show(raw)
        await waitFor(store) { $0 == .failed("Not available for this camera") }
        XCTAssertTrue(store.images.isEmpty)
    }

    func testBusyRendererIsRetried() async {
        let api = TestAPI()
        let busy = PhotoBrainAPIError.server(status: 503, code: "DEVELOP_BUSY", message: "busy")
        await api.setDevelopedResults([
            .failure(busy),
            .failure(busy),
            .success(DevelopedRawImage(data: Self.jpeg(), width: 6000, height: 4000)),
        ])
        let store = LoupeDevelopedStore(api: api, busyDelay: .zero, cache: cache)
        store.show(raw)
        await waitFor(store) { $0 == .developed(width: 6000, height: 4000) }
        let requests = await api.developedRequests
        XCTAssertEqual(requests, [2, 2, 2])
    }

    func testNonRawPhotosStayEmbedded() async {
        let api = TestAPI()
        let store = LoupeDevelopedStore(api: api, busyDelay: .zero, cache: cache)
        store.show(record(TestModels.photo(id: 1)))
        XCTAssertEqual(store.rendition, .embedded)
        let requests = await api.developedRequests
        XCTAssertEqual(requests, [])
    }
}
