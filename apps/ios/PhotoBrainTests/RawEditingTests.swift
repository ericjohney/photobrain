import CoreGraphics
import UIKit
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

    private func editingAPI(delay: Duration = .zero, recipe: RawEditRecipe? = nil) async -> TestAPI {
        let api = TestAPI()
        let data = UIGraphicsImageRenderer(size: CGSize(width: 3, height: 2)).jpegData(withCompressionQuality: 0.9) { context in
            UIColor.gray.setFill()
            context.fill(CGRect(x: 0, y: 0, width: 3, height: 2))
        }
        await api.configureRawEditing(data: data, recipe: recipe, delay: delay)
        return api
    }

    func testSliderCoalescesPendingValuesAndRefinesFinalValue() async {
        let api = await editingAPI(delay: .milliseconds(60))
        let store = LoupeRawEditStore(api: api)
        store.start(raw)
        await waitUntil { store.isReady }
        store.setDragging(true)
        await waitUntil { await api.rawPreviewRequests.count == 2 }
        for i in 0..<50 { store.set(.exposure, value: Double(i) / 25 - 1) }
        store.set(.exposure, value: 2)
        store.set(.shadows, value: 40)
        store.setDragging(false)
        await waitUntil { store.appliedSettings.exposure == 2 && !store.isRendering }
        let requests = await api.rawPreviewRequests
        XCTAssertEqual(requests.count, 3) // baseline, first in-flight edit, final refined edit
        XCTAssertEqual(requests.last?.settings.shadows, 40)
        XCTAssertEqual(requests.last?.refined, true)
        let saves = await api.rawSaveRequests
        XCTAssertTrue(saves.isEmpty)
        store.end()
    }

    func testSaveReopensRecipeAndCancelLeavesSavedSettingsIntact() async {
        let api = await editingAPI()
        let store = LoupeRawEditStore(api: api)
        store.start(raw)
        await waitUntil { store.isReady }
        store.set(.exposure, value: 0.7)
        store.set(.highlights, value: -50)
        let saved = await store.save()
        XCTAssertTrue(saved)
        XCTAssertFalse(store.hasChanges)
        store.end()
        store.start(raw)
        await waitUntil { store.isReady && store.settings.exposure == 0.7 }
        XCTAssertEqual(store.settings.highlights, -50)
        store.reset()
        XCTAssertTrue(store.hasChanges)
        store.end()
        let recipe = try? await api.rawEdit(photoId: 2)
        XCTAssertEqual(recipe?.settings.exposure, 0.7)
    }

    func testConflictKeepsDraftAndShowsError() async {
        let api = await editingAPI()
        let store = LoupeRawEditStore(api: api)
        store.start(raw)
        await waitUntil { store.isReady }
        store.set(.exposure, value: 1)
        await api.setRawSaveFailure(.server(status: 409, code: "RAW_EDIT_CONFLICT", message: "Edited elsewhere"))
        let saved = await store.save()
        XCTAssertFalse(saved)
        XCTAssertEqual(store.settings.exposure, 1)
        XCTAssertTrue(store.hasChanges)
        XCTAssertNotNil(store.errorMessage)
        store.end()
    }

    func testBeforeAfterDoesNotChangeDraftAndAppleOffersOnlyExposure() async {
        let recipe = RawEditRecipe(settings: RawEditSettings(), revision: 0, engine: "apple", supportsTone: false)
        let api = await editingAPI(recipe: recipe)
        let store = LoupeRawEditStore(api: api)
        store.start(raw)
        await waitUntil { store.isReady }
        XCTAssertEqual(store.controls, [.exposure])
        store.set(.contrast, value: 50)
        XCTAssertEqual(store.settings.contrast, 0)
        store.set(.exposure, value: 1)
        store.toggleBefore()
        XCTAssertTrue(store.showingBefore)
        XCTAssertEqual(store.settings.exposure, 1)
        store.toggleBefore()
        XCTAssertFalse(store.showingBefore)
        store.end()
    }

    func testEndDiscardsAnUncooperativeLateFrame() async {
        let api = await editingAPI(delay: .milliseconds(100))
        let store = LoupeRawEditStore(api: api)
        store.start(raw)
        await waitUntil { await api.rawPreviewRequests.count == 1 }
        store.end()
        try? await Task.sleep(for: .milliseconds(150))
        XCTAssertEqual(store.phase, .inactive)
        XCTAssertTrue(store.images.isEmpty)
        XCTAssertEqual(store.settings.exposure, 0)
    }

    func testClientSendsRecipeRevisionAndStructuredPreviewBody() async throws {
        StubURLProtocol.reset()
        defer { StubURLProtocol.reset() }
        let client = StubURLProtocol.makeClient()
        let recipe = RawEditRecipe(settings: RawEditSettings(exposure: 0.7, highlights: -50), revision: 2, engine: "adobe", supportsTone: true)
        let body = String(data: try JSONEncoder().encode(recipe), encoding: .utf8)!
        StubURLProtocol.respond(status: 200, body: body)
        let loaded = try await client.rawEdit(photoId: 2)
        XCTAssertEqual(loaded, recipe)
        XCTAssertEqual(StubURLProtocol.requests.last?.url?.path, "/api/v1/photos/2/raw-edit")
        _ = try await client.saveRawEdit(photoId: 2, settings: recipe.settings, revision: 2)
        let saved = try XCTUnwrap(StubURLProtocol.requests.last)
        XCTAssertEqual(saved.httpMethod, "PUT")
        let requestBody = try XCTUnwrap(JSONSerialization.jsonObject(with: XCTUnwrap(saved.httpBody)) as? [String: Any])
        XCTAssertEqual(requestBody["revision"] as? Int, 2)
        _ = try await client.rawEditPreview(photoId: 2, settings: recipe.settings, refined: false)
        let preview = try XCTUnwrap(StubURLProtocol.requests.last)
        XCTAssertEqual(preview.httpMethod, "POST")
        XCTAssertEqual(preview.url?.path, "/api/photos/2/developed")
        let previewBody = try XCTUnwrap(JSONSerialization.jsonObject(with: XCTUnwrap(preview.httpBody)) as? [String: Any])
        XCTAssertEqual(previewBody["refined"] as? Bool, false)
        XCTAssertEqual((previewBody["settings"] as? [String: Any])?["highlights"] as? Int, -50)
    }

    func testFailedOpenShowsReasonWithoutDownloadingOriginal() async {
        let api = TestAPI()
        await api.setRawEditFailure(.server(status: 404, code: "PHOTO_NOT_FOUND", message: "Photo missing"))
        let store = LoupeRawEditStore(api: api)
        store.start(raw)
        await waitUntil { if case .failed = store.phase { return true }; return false }
        let downloads = await api.exportRequests
        XCTAssertTrue(downloads.isEmpty)
        store.end()
    }
}
