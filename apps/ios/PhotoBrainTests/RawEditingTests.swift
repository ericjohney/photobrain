import CoreGraphics
import XCTest
@testable import PhotoBrain

@MainActor
final class RawEditingTests: XCTestCase {
    private var raw: PhotoRecord {
        PhotoRecord(
            dto: TestModels.photo(id: 2, name: "synthetic.ARW", isRaw: true, rawFormat: "ARW"),
            apiBaseURL: URL(string: "https://photos.example.invalid")!
        )
    }

    private func waitUntil(_ predicate: @escaping @MainActor () async -> Bool) async {
        for _ in 0..<300 {
            if await predicate() { return }
            try? await Task.sleep(for: .milliseconds(10))
        }
        XCTFail("Timed out")
    }

    func testNativeBridgeProducesOrientedP3PixelsAndExposureChanges() async throws {
        let file = try XCTUnwrap(Bundle(for: Self.self).url(forResource: "synthetic", withExtension: "ARW"))
        let renderer = NativeRawEditRenderer()
        let token = RawEditCancellation()
        let id = UUID()
        try await renderer.open(file: file, id: id, cancellation: token)
        let zero = try await renderer.render(id: id, exposure: 0, refined: true, cancellation: token)
        let bright = try await renderer.render(id: id, exposure: 1, refined: false, cancellation: token)
        let reset = try await renderer.render(id: id, exposure: 0, refined: true, cancellation: token)
        XCTAssertEqual(zero.image.width, 72) // orientation 6, half-resolution Bayer preview
        XCTAssertEqual(zero.image.height, 96)
        XCTAssertEqual(zero.image.colorSpace?.name, CGColorSpace.displayP3)
        XCTAssertNotEqual(zero.image.dataProvider!.data! as Data, bright.image.dataProvider!.data! as Data)
        XCTAssertEqual(zero.image.dataProvider!.data! as Data, reset.image.dataProvider!.data! as Data)
        token.cancel()
        do {
            _ = try await renderer.render(id: id, exposure: 0, refined: true, cancellation: token)
            XCTFail("Expected cancellation")
        } catch is CancellationError { }
        await renderer.release(id: id)
    }

    /// Opt-in local validation, including both ProRAW codecs and a 48 MP file. Originals
    /// stay outside the repo. TEST_RUNNER_ forwards the host path into the simulator runner.
    func testRealRawFilesWhenConfigured() async throws {
        guard let path = ProcessInfo.processInfo.environment["PHOTOBRAIN_RAW_FIXTURES"] else {
            throw XCTSkip("Set TEST_RUNNER_PHOTOBRAIN_RAW_FIXTURES to the local fixture directory")
        }
        let root = URL(fileURLWithPath: path, isDirectory: true)
        let renderer = NativeRawEditRenderer()
        for name in ["DSCF0970.RAF", "a7cr/6453.ARW", "iphone16pm/12686.DNG", "iphone17pm/116.DNG", "iphone-more/13109.DNG"] {
            let id = UUID()
            let token = RawEditCancellation()
            let start = CFAbsoluteTimeGetCurrent()
            try await renderer.open(file: root.appendingPathComponent(name), id: id, cancellation: token)
            let prepareMS = (CFAbsoluteTimeGetCurrent() - start) * 1000
            var timings: [Double] = []
            for i in 0..<33 {
                let frame = try await renderer.render(id: id, exposure: Double(i % 21) / 10 - 1,
                                                      refined: false, cancellation: token)
                XCTAssertLessThanOrEqual(max(frame.image.width, frame.image.height), 1024)
                if i >= 3 { timings.append(frame.milliseconds) }
            }
            let refined = try await renderer.render(id: id, exposure: 0, refined: true, cancellation: token)
            XCTAssertLessThanOrEqual(max(refined.image.width, refined.image.height), 2048)
            await renderer.release(id: id)
            timings.sort()
            print(String(format: "RAW_EDIT_SIM %@ prepare=%.1fms drag-p50=%.1fms drag-p95=%.1fms release=%.1fms",
                         name, prepareMS, timings[14], timings[28], refined.milliseconds))
        }
    }

    func testSliderCoalescesPendingValuesAndRefinesFinalValue() async throws {
        let api = TestAPI()
        let renderer = ControlledRawRenderer()
        let store = LoupeRawEditStore(api: api, renderer: renderer)
        store.start(raw)
        await waitUntil { await renderer.requests.count == 1 }
        store.setDragging(true)
        for i in 0..<50 { store.setExposure(Double(i) / 25 - 1) }
        store.setExposure(2)
        store.setDragging(false)
        await renderer.resume()
        await waitUntil { store.appliedExposure == 2 && store.images[2] != nil }
        let requests = await renderer.requests
        XCTAssertEqual(requests.count, 2)
        XCTAssertEqual(requests.last?.exposure, 2)
        XCTAssertEqual(requests.last?.refined, true)
        let downloads = await api.exportRequests
        let files = api.exportFilesOnDisk()
        XCTAssertEqual(downloads, [.photo(id: 2, size: .original)])
        XCTAssertTrue(files.isEmpty)
        store.end()
        XCTAssertFalse(store.isActive)
        XCTAssertTrue(store.images.isEmpty)
    }

    func testEndDiscardsAnUncooperativeLateFrame() async {
        let api = TestAPI()
        let renderer = ControlledRawRenderer()
        let store = LoupeRawEditStore(api: api, renderer: renderer)
        store.start(raw)
        await waitUntil { await renderer.requests.count == 1 }
        store.end()
        await renderer.resume()
        await waitUntil { await renderer.releaseCount > 0 }
        XCTAssertEqual(store.phase, .inactive)
        XCTAssertTrue(store.images.isEmpty)
        XCTAssertEqual(store.exposure, 0)
    }

    func testFailedOpenDeletesDownloadedOriginalAndShowsReason() async {
        let api = TestAPI()
        let store = LoupeRawEditStore(api: api) // the fake download contains JPEG placeholder bytes
        store.start(raw)
        await waitUntil { if case .failed = store.phase { return true }; return false }
        XCTAssertTrue(store.images.isEmpty)
        let files = api.exportFilesOnDisk()
        XCTAssertTrue(files.isEmpty)
        store.end()
    }

    func testCancellingDownloadNeverOpensRenderer() async {
        let api = TestAPI()
        await api.setExport(.file(name: "synthetic.ARW", bytes: Data()), delay: .seconds(5))
        let renderer = ControlledRawRenderer()
        let store = LoupeRawEditStore(api: api, renderer: renderer)
        store.start(raw)
        await waitUntil { await api.exportRequests.count == 1 }
        store.end()
        await waitUntil { api.exportFilesOnDisk().isEmpty }
        let opens = await renderer.openCount
        XCTAssertEqual(opens, 0)
        XCTAssertEqual(store.phase, .inactive)
    }
}

private actor ControlledRawRenderer: RawEditRendering {
    struct Request: Sendable {
        let exposure: Double
        let refined: Bool
    }
    var requests: [Request] = []
    var releaseCount = 0
    var openCount = 0
    private var held = true
    private var continuation: CheckedContinuation<Void, Never>?

    func open(file: URL, id: UUID, cancellation: RawEditCancellation) { openCount += 1 }
    func render(id: UUID, exposure: Double, refined: Bool, cancellation: RawEditCancellation) async throws -> RawEditFrame {
        requests.append(Request(exposure: exposure, refined: refined))
        if held { await withCheckedContinuation { continuation = $0 } }
        let provider = CGDataProvider(data: Data([100, 100, 100, 255]) as CFData)!
        let image = CGImage(width: 1, height: 1, bitsPerComponent: 8, bitsPerPixel: 32,
                            bytesPerRow: 4, space: CGColorSpace(name: CGColorSpace.displayP3)!,
                            bitmapInfo: CGBitmapInfo(rawValue: CGImageAlphaInfo.last.rawValue),
                            provider: provider, decode: nil, shouldInterpolate: false, intent: .defaultIntent)!
        return RawEditFrame(image: image, milliseconds: 1)
    }
    func release(id: UUID) { releaseCount += 1 }
    func resume() {
        held = false
        continuation?.resume()
        continuation = nil
    }
}
