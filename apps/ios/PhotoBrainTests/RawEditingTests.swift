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

    func testSmartPreviewEditsOfflineAndRestoresDraftAfterRestartThenSyncs() async throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: root) }
        let cache = SmartPreviewCache(root: root)
        let api = await editingAPI(recipe: RawEditRecipe(settings: RawEditSettings(), revision: 0, engine: "apple", supportsTone: false))
        let file = try XCTUnwrap(Bundle(for: Self.self).url(forResource: "synthetic", withExtension: "pbsp"))
        await api.configureSmartPreview(try Data(contentsOf: file))
        let store = LoupeRawEditStore(api: api, cache: cache)
        store.start(raw)
        await waitUntil { store.isReady && store.isLocal }
        let before = try XCTUnwrap(store.images[raw.id]?.cgImage?.dataProvider?.data) as Data
        await api.setRawEditFailure(.transport("Offline"))
        store.set(.exposure, value: 1.25)
        await waitUntil { store.appliedSettings.exposure == 1.25 && !store.isRendering }
        let edited = try XCTUnwrap(store.images[raw.id]?.cgImage?.dataProvider?.data) as Data
        XCTAssertNotEqual(before, edited)
        await waitUntil { await cache.entry(api.baseURL, 2)?.draft?.exposure == 1.25 }
        store.end()
        // A new cache instance reads disk, not the first store's memory.
        let reopenedCache = SmartPreviewCache(root: root)
        let recovered = LoupeRawEditStore(api: api, cache: reopenedCache)
        recovered.start(raw)
        await waitUntil { recovered.isReady && recovered.appliedSettings.exposure == 1.25 }
        XCTAssertEqual(recovered.settings.exposure, 1.25)
        XCTAssertTrue(["Recovered unsaved adjustments", "Offline · Edits stay on this device"].contains(recovered.storageMessage ?? ""))
        let offlineSaved = await recovered.save()
        XCTAssertFalse(offlineSaved)
        XCTAssertEqual(recovered.storageMessage, "Saved on device · Will sync when online")
        let pending = await reopenedCache.entry(api.baseURL, 2)
        XCTAssertEqual(pending?.pending?.exposure, 1.25)
        XCTAssertNil(pending?.draft)
        await api.setRawEditFailure(nil)
        _ = try await reopenedCache.sync(api: api, rawID: 2)
        let saved = try await api.rawEdit(photoId: 2)
        XCTAssertEqual(saved.settings.exposure, 1.25)
        XCTAssertEqual(saved.revision, 1)
        let synced = await reopenedCache.entry(api.baseURL, 2)
        XCTAssertNil(synced?.pending)
        XCTAssertEqual(synced?.recipe, saved)
        recovered.end()
    }

    func testSmartCacheEvictsOldCleanPreviewsAndKeepsDraftsAndOriginBoundaries() async throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: root) }
        let cache = SmartPreviewCache(root: root, limit: 8)
        let origin = URL(string: "https://one.example")!
        let other = URL(string: "https://two.example")!
        let recipe = RawEditRecipe(settings: RawEditSettings(), revision: 0, engine: "apple", supportsTone: false)
        for id in 1...3 {
            let entry = SmartPreviewCache.Entry(photo: raw, rawID: id, recipe: recipe, token: "t", draft: id == 1 ? RawEditSettings(exposure: 1) : nil, pending: nil, accessed: Date(timeIntervalSince1970: Double(id)))
            try await cache.store(Data(repeating: UInt8(id), count: 4), entry: entry, origin: origin)
        }
        let oldest = await cache.entry(origin, 1)
        let evicted = await cache.entry(origin, 2)
        let newest = await cache.entry(origin, 3)
        let crossOrigin = await cache.entry(other, 1)
        XCTAssertNotNil(oldest?.draft)
        XCTAssertNil(evicted)
        XCTAssertNotNil(newest)
        XCTAssertNil(crossOrigin)
    }

    func testSmartSyncConflictKeepsPendingAndLostResponseDoesNotDoubleSave() async throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: root) }
        let cache = SmartPreviewCache(root: root)
        let api = await editingAPI()
        let recipe = try await api.rawEdit(photoId: 2)
        let pending = RawEditSettings(exposure: 1)
        let entry = SmartPreviewCache.Entry(photo: raw, rawID: 2, recipe: recipe, token: "t", draft: nil, pending: pending, accessed: Date())
        try await cache.store(Data([1]), entry: entry, origin: api.baseURL)
        _ = try await api.saveRawEdit(photoId: 2, settings: RawEditSettings(exposure: 2), revision: 0)
        do { _ = try await cache.sync(api: api, rawID: 2); XCTFail("Expected conflict") }
        catch { XCTAssertTrue(error.localizedDescription.contains("edited elsewhere")) }
        let kept = await cache.entry(api.baseURL, 2)
        XCTAssertEqual(kept?.pending, pending)
        _ = try await api.saveRawEdit(photoId: 2, settings: pending, revision: 1)
        _ = try await cache.sync(api: api, rawID: 2)
        let requests = await api.rawSaveRequests
        XCTAssertEqual(requests.count, 2) // The already successful save was acknowledged.
        let synced = await cache.entry(api.baseURL, 2)
        XCTAssertNil(synced?.pending)
    }


    func testConcurrentSyncWaitersSeeCommittedJournalAndStorageRefusesToEvictDrafts() async throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: root) }
        let cache = SmartPreviewCache(root: root, limit: 4)
        let api = await editingAPI()
        let recipe = try await api.rawEdit(photoId: 2)
        let settings = RawEditSettings(exposure: 0.5)
        let entry = SmartPreviewCache.Entry(photo: raw, rawID: 2, recipe: recipe, token: "t", draft: nil, pending: settings, accessed: Date())
        try await cache.store(Data(repeating: 0, count: 4), entry: entry, origin: api.baseURL)
        let another = SmartPreviewCache.Entry(photo: raw, rawID: 3, recipe: recipe, token: "t", draft: nil, pending: nil, accessed: Date())
        do { try await cache.store(Data([1]), entry: another, origin: api.baseURL); XCTFail("Expected full cache") }
        catch { XCTAssertTrue(error.localizedDescription.contains("storage is full")) }
        let retained = await cache.entry(api.baseURL, 2)
        XCTAssertEqual(retained?.pending, settings)
        async let first = cache.sync(api: api, rawID: 2)
        async let second = cache.sync(api: api, rawID: 2)
        let results = try await [first, second]
        XCTAssertEqual(results[0]?.revision, 1)
        let finished = await cache.entry(api.baseURL, 2)
        XCTAssertNil(finished?.pending)
        let saves = await api.rawSaveRequests
        XCTAssertEqual(saves.count, 1)
    }


    func testFullDevelopedSharingWaitsForSyncAndRefusesOfflineStaleRecipe() async throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: root) }
        let cache = SmartPreviewCache(root: root)
        let api = await editingAPI()
        let recipe = try await api.rawEdit(photoId: 2)
        let entry = SmartPreviewCache.Entry(photo: raw, rawID: 2, recipe: recipe, token: "t", draft: nil, pending: RawEditSettings(exposure: 1), accessed: Date())
        try await cache.store(Data([1]), entry: entry, origin: api.baseURL)
        await api.setRawEditFailure(.transport("Offline"))
        let exports = ExportStore(api: api, rawCache: cache)
        exports.start(.developed(id: 2))
        await waitUntil { if case .failed = exports.state { return true }; return false }
        let blocked = await api.exportRequests
        XCTAssertTrue(blocked.isEmpty)
        await api.setRawEditFailure(nil)
        exports.dismissError()
        exports.start(.developed(id: 2))
        await waitUntil { exports.readyFile != nil }
        let remote = try await api.rawEdit(photoId: 2)
        XCTAssertEqual(remote.settings.exposure, 1)
        XCTAssertEqual(remote.revision, 1)
        let journal = await cache.entry(api.baseURL, 2)
        XCTAssertNil(journal?.pending)
        exports.finishSharing()
    }


    func testRealSmartPreviewOnSimulatorWhenConfigured() async throws {
        guard let path = ProcessInfo.processInfo.environment["PHOTOBRAIN_SMART_PREVIEW"] else {
            throw XCTSkip("Set TEST_RUNNER_PHOTOBRAIN_SMART_PREVIEW to a generated Adobe .pbsp file")
        }
        let data = try Data(contentsOf: URL(fileURLWithPath: path))
        let renderer = SmartRawEditRenderer()
        let token = RawEditCancellation()
        let started = CFAbsoluteTimeGetCurrent()
        try await renderer.open(data: data, cancellation: token)
        let openMS = (CFAbsoluteTimeGetCurrent() - started) * 1000
        let zero = try await renderer.render(RawEditSettings(), refined: true, cancellation: token)
        let settings = RawEditSettings(exposure: 0.7, contrast: 30, highlights: -50, shadows: 40, whites: 20, blacks: -25)
        var timings: [Double] = []
        for _ in 0..<12 {
            let start = CFAbsoluteTimeGetCurrent()
            let image = try await renderer.render(settings, refined: false, cancellation: token)
            XCTAssertLessThanOrEqual(max(image.size.width, image.size.height), 1024)
            timings.append((CFAbsoluteTimeGetCurrent() - start) * 1000)
        }
        let start = CFAbsoluteTimeGetCurrent()
        let changed = try await renderer.render(settings, refined: true, cancellation: token)
        let refinedMS = (CFAbsoluteTimeGetCurrent() - start) * 1000
        let reset = try await renderer.render(RawEditSettings(), refined: true, cancellation: token)
        let baselineBytes = try XCTUnwrap(zero.cgImage?.dataProvider?.data) as Data
        let resetBytes = try XCTUnwrap(reset.cgImage?.dataProvider?.data) as Data
        let changedBytes = try XCTUnwrap(changed.cgImage?.dataProvider?.data) as Data
        XCTAssertEqual(baselineBytes, resetBytes)
        XCTAssertNotEqual(baselineBytes, changedBytes)
        XCTAssertEqual(changed.cgImage?.colorSpace?.name, CGColorSpace.displayP3)
        timings.removeFirst(2); timings.sort()
        print(String(format: "SMART_PREVIEW_SIM bytes=%d open=%.1fms mixed-six-controls-drag-p50=%.1fms drag-p95=%.1fms refined=%.1fms", data.count, openMS, timings[4], timings[9], refinedMS))
    }


    func testLatePreviewRefreshCannotReplaceANewerSave() async throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: root) }
        let cache = SmartPreviewCache(root: root)
        let api = await editingAPI(recipe: RawEditRecipe(settings: RawEditSettings(), revision: 0, engine: "apple", supportsTone: false))
        let file = try XCTUnwrap(Bundle(for: Self.self).url(forResource: "synthetic", withExtension: "pbsp"))
        let data = try Data(contentsOf: file)
        await api.configureSmartPreview(data, delay: .milliseconds(150))
        let recipe = try await api.rawEdit(photoId: 2)
        let entry = SmartPreviewCache.Entry(photo: raw, rawID: 2, recipe: recipe, token: "test-v1", draft: nil, pending: nil, accessed: Date())
        try await cache.store(data, entry: entry, origin: api.baseURL)
        let store = LoupeRawEditStore(api: api, cache: cache)
        store.start(raw)
        await waitUntil {
            let requests = await api.smartPreviewRequests
            return store.isReady && requests > 0
        }
        store.set(.exposure, value: 1)
        let saved = await store.save()
        XCTAssertTrue(saved)
        try await Task.sleep(for: .milliseconds(200))
        XCTAssertEqual(store.settings.exposure, 1)
        let journal = await cache.entry(api.baseURL, 2)
        XCTAssertEqual(journal?.recipe.revision, 1)
        XCTAssertEqual(journal?.recipe.settings.exposure, 1)
        store.end()
    }

}
