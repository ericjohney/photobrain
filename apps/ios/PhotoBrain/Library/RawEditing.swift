import CoreGraphics
import CryptoKit
import Foundation
import RawDevelop
import UIKit

/// Shared with Rust; cancellation is the only operation allowed across render threads.
final class RawEditCancellation: @unchecked Sendable {
    let handle = pbraw_cancel_new()!
    func cancel() { pbraw_cancel_request(handle) }
    deinit { pbraw_cancel_free(handle) }
}

struct RawEditFrame: @unchecked Sendable {
    let image: CGImage
    let milliseconds: Double
}

struct RawEditError: LocalizedError {
    let message: String
    var errorDescription: String? { message }

    static func take(_ error: inout PBRAWError) -> Error {
        defer { pbraw_error_clear(&error) }
        if error.code == 4 { return CancellationError() }
        if error.code == 2 { return Self(message: "Not available for this camera") }
        return Self(message: error.message.map { String(cString: $0) } ?? "Couldn’t develop this RAW")
    }
}

/// An actor owns the opaque Rust session, serialising preparation, renders and destruction.
/// CGImage owns a copy of the returned RGBA8 pixels, tagged Display P3 (no JPEG encode).
actor NativeRawEditRenderer: RawEditRendering {
    private var session: OpaquePointer?
    private var sessionID: UUID?

    func open(file: URL, id: UUID, cancellation: RawEditCancellation) throws {
        try Task.checkCancellation()
        if let session { pbraw_session_free(session) }
        session = nil
        sessionID = nil
        var error = PBRAWError()
        let result = file.path.withCString { pbraw_open($0, cancellation.handle, &error) }
        guard let result else { throw RawEditError.take(&error) }
        // A cancelled open must release the newly prepared pixels, too.
        if Task.isCancelled {
            pbraw_session_free(result)
            throw CancellationError()
        }
        session = result
        sessionID = id
    }

    func render(id: UUID, exposure: Double, refined: Bool, cancellation: RawEditCancellation) throws -> RawEditFrame {
        try Task.checkCancellation()
        guard id == sessionID, let session else { throw CancellationError() }
        let start = CFAbsoluteTimeGetCurrent()
        var error = PBRAWError()
        guard let output = pbraw_render(session, exposure, refined ? 1 : 0, cancellation.handle, &error) else {
            throw RawEditError.take(&error)
        }
        defer { pbraw_image_free(output) }
        try Task.checkCancellation()
        let width = pbraw_image_width(output)
        let height = pbraw_image_height(output)
        guard let pixels = pbraw_image_pixels(output), width > 0, height > 0,
              let colour = CGColorSpace(name: CGColorSpace.displayP3),
              let provider = CGDataProvider(data: Data(bytes: pixels, count: pbraw_image_len(output)) as CFData),
              let image = CGImage(
                width: width, height: height, bitsPerComponent: 8, bitsPerPixel: 32,
                bytesPerRow: width * 4, space: colour,
                bitmapInfo: CGBitmapInfo(rawValue: CGImageAlphaInfo.last.rawValue),
                provider: provider, decode: nil, shouldInterpolate: true, intent: .defaultIntent
              ) else { throw RawEditError(message: "Couldn’t display the RAW preview") }
        return RawEditFrame(image: image, milliseconds: (CFAbsoluteTimeGetCurrent() - start) * 1000)
    }

    func release(id: UUID) {
        guard sessionID == id else { return }
        if let session { pbraw_session_free(session) }
        session = nil
        sessionID = nil
    }

    deinit {
        if let session { pbraw_session_free(session) }
    }
}

protocol RawEditRendering: Sendable {
    func open(file: URL, id: UUID, cancellation: RawEditCancellation) async throws
    func render(id: UUID, exposure: Double, refined: Bool, cancellation: RawEditCancellation) async throws -> RawEditFrame
    func release(id: UUID) async
}

/// Versioned, nondestructive Basic adjustments shared by previews, persistence and export.
struct RawEditSettings: Codable, Equatable, Sendable {
    var version = 1
    var exposure = 0.0
    var contrast = 0
    var highlights = 0
    var shadows = 0
    var whites = 0
    var blacks = 0
}

struct RawEditRecipe: Codable, Equatable, Sendable {
    let settings: RawEditSettings
    let revision: Int
    let engine: String
    let supportsTone: Bool
}

enum RawEditControl: String, CaseIterable, Identifiable {
    case exposure, contrast, highlights, shadows, whites, blacks
    var id: String { rawValue }
    var title: String { rawValue.capitalized }
    var symbol: String {
        switch self {
        case .exposure: "plusminus.circle"
        case .contrast: "circle.lefthalf.filled"
        case .highlights: "sun.max"
        case .shadows: "moon"
        case .whites: "circle"
        case .blacks: "circle.fill"
        }
    }
    var range: ClosedRange<Double> { self == .exposure ? -5...5 : -100...100 }
    var step: Double { self == .exposure ? 0.05 : 1 }
    func value(in settings: RawEditSettings) -> Double {
        switch self {
        case .exposure: settings.exposure
        case .contrast: Double(settings.contrast)
        case .highlights: Double(settings.highlights)
        case .shadows: Double(settings.shadows)
        case .whites: Double(settings.whites)
        case .blacks: Double(settings.blacks)
        }
    }
    func label(in settings: RawEditSettings) -> String {
        self == .exposure ? String(format: "%+.2f EV", value(in: settings)) : String(format: "%+.0f", value(in: settings))
    }
    func set(_ value: Double, in settings: inout RawEditSettings) {
        guard value.isFinite else { return }
        let value = min(range.upperBound, max(range.lowerBound, value))
        switch self {
        case .exposure: settings.exposure = (value * 100).rounded() / 100
        case .contrast: settings.contrast = Int(value.rounded())
        case .highlights: settings.highlights = Int(value.rounded())
        case .shadows: settings.shadows = Int(value.rounded())
        case .whites: settings.whites = Int(value.rounded())
        case .blacks: settings.blacks = Int(value.rounded())
        }
    }
}

/// A local smart-preview session with a server fallback. Only Save queues the recipe. Intermediate slider positions
/// are coalesced; late frames from a closed/replaced session are always discarded.
@MainActor
final class LoupeRawEditStore: ObservableObject {
    enum Phase: Equatable { case inactive, loading, ready, failed(String) }
    @Published private(set) var phase: Phase = .inactive
    @Published private(set) var images: [Int: UIImage] = [:]
    @Published private(set) var settings = RawEditSettings()
    @Published private(set) var supportsTone = false
    @Published private(set) var engine = ""
    @Published private(set) var isRendering = false
    @Published private(set) var isSaving = false
    @Published private(set) var showingBefore = false
    @Published private(set) var errorMessage: String?
    @Published private(set) var appliedSettings = RawEditSettings()
    @Published private(set) var isLocal = false
    @Published private(set) var storageMessage: String?

    var isActive: Bool { phase != .inactive }
    var isReady: Bool { phase == .ready }
    var hasChanges: Bool { settings != savedSettings }
    var label: String {
        if showingBefore { return "Before adjustments" }
        switch phase {
        case .inactive: return "Embedded preview"
        case .loading: return "Preparing RAW…"
        case .ready: return isRendering ? "Updating preview…" : (isLocal ? "Smart preview · On device" : "RAW adjustments")
        case .failed: return "RAW edit unavailable"
        }
    }
    var controls: [RawEditControl] { supportsTone ? RawEditControl.allCases : [.exposure] }

    private let api: any PhotoBrainAPI
    private var id: UUID?
    private var photoID: Int?
    private var rawID: Int?
    private var savedSettings = RawEditSettings()
    private var savedRevision = 0
    private var beforeImage: UIImage?
    private var currentImage: UIImage?
    private var openTask: Task<Void, Never>?
    private var renderTask: Task<Void, Never>?
    private var revision = 0
    private var dragging = false
    private let cache: SmartPreviewCache
    private var local: SmartRawEditRenderer?
    private var localToken = RawEditCancellation()
    private var journalTask: Task<Void, Never>?
    private var refreshTask: Task<Void, Never>?


    init(api: any PhotoBrainAPI, cache: SmartPreviewCache = .shared) { self.api = api; self.cache = cache }

    func start(_ photo: PhotoRecord) {
        end()
        guard let rawID = LoupeRendition.developableRawID(for: photo) else { return }
        let id = UUID()
        self.id = id
        self.photoID = photo.id
        self.rawID = rawID
        phase = .loading
        let previousJournal = journalTask
        openTask = Task { [weak self, api, cache] in
            await previousJournal?.value
            do {
                if let cached = await cache.entry(api.baseURL, rawID), cached.generation == photo.thumbnailUpdatedAt {
                    do {
                        let file = await cache.file(api.baseURL, rawID)
                        let data = try await Task.detached { try Data(contentsOf: file, options: .mappedIfSafe) }.value
                        guard let self, self.id == id else { return }
                        try await self.openLocal(data: data, entry: cached, id: id)
                        self.refreshCached(photo: photo, entry: cached, id: id)
                        return
                    } catch is CancellationError { throw CancellationError() }
                    catch { /* Re-download incompatible or evicted state online. Draft metadata remains. */ }
                }
                let recipe = try await api.rawEdit(photoId: rawID)
                guard let self, self.id == id else { return }
                let previous = await cache.entry(api.baseURL, rawID)
                if let previous, (previous.pending != nil || previous.draft != nil), previous.generation != photo.thumbnailUpdatedAt {
                    throw RawEditError(message: "The source photo changed. Your offline adjustments are kept for review.")
                }
                do {
                    let download = try await api.smartPreview(photoId: rawID, token: nil)
                    guard let data = download.data, download.engine == recipe.engine else { throw PhotoBrainAPIError.invalidResponse }
                    let entry = SmartPreviewCache.Entry(photo: photo, rawID: rawID, recipe: previous?.pending != nil || previous?.draft != nil ? previous!.recipe : recipe,
                                                        token: download.token, draft: previous?.draft, pending: previous?.pending, accessed: Date())
                    try await self.openLocal(data: data, entry: entry, id: id)
                    try await cache.store(data, entry: entry, origin: api.baseURL)
                    return
                } catch is CancellationError { throw CancellationError() }
                catch {
                    self.local = nil; self.isLocal = false
                    self.storageMessage = nil
                    // Older servers retain the existing server-preview editor.
                }
                let baseline = try await Self.preview(api: api, rawID: rawID, settings: RawEditSettings(), refined: true)
                let image = try await Self.decode(baseline)
                guard !Task.isCancelled, self.id == id else { return }
                self.applyRecipe(recipe)
                self.beforeImage = image
                self.currentImage = image
                self.images = [photo.id: image]
                self.phase = .ready
                if recipe.settings != RawEditSettings() { self.requestRender() }
            } catch {
                guard !Task.isCancelled, let self, self.id == id else { return }
                self.phase = .failed(error.localizedDescription)
            }
        }
    }

    private func applyRecipe(_ recipe: RawEditRecipe) {
        savedSettings = recipe.settings; savedRevision = recipe.revision
        settings = recipe.settings; supportsTone = recipe.supportsTone; engine = recipe.engine
    }

    private func openLocal(data: Data, entry: SmartPreviewCache.Entry, id: UUID) async throws {
        let renderer = SmartRawEditRenderer()
        try await renderer.open(data: data, cancellation: localToken)
        let baseline = try await renderer.render(RawEditSettings(), refined: true, cancellation: localToken)
        guard self.id == id, !Task.isCancelled else { throw CancellationError() }
        local = renderer; isLocal = true
        applyRecipe(entry.recipe)
        savedSettings = entry.pending ?? entry.recipe.settings
        settings = entry.draft ?? savedSettings
        beforeImage = baseline; currentImage = baseline
        storageMessage = entry.pending != nil ? "Saved on device · Waiting to sync" : (entry.draft != nil ? "Recovered unsaved adjustments" : "Available offline")
        showImage(); phase = .ready
        if settings != RawEditSettings() { requestRender() }
    }

    private func refreshCached(photo: PhotoRecord, entry: SmartPreviewCache.Entry, id: UUID) {
        refreshTask = Task { [weak self, api, cache] in
            do {
                _ = try await cache.sync(api: api, rawID: entry.rawID)
                let fetched = try await api.rawEdit(photoId: entry.rawID)
                let download = try await api.smartPreview(photoId: entry.rawID, token: entry.token)
                guard let self, self.id == id, !Task.isCancelled else { return }
                let latest = await cache.entry(api.baseURL, entry.rawID) ?? entry
                // A Save can finish while the preview is downloading. Never replace its
                // newer recipe with the response captured before that download.
                let remote = fetched.revision < latest.recipe.revision ? latest.recipe : fetched
                guard remote.engine == self.engine else { throw RawEditError(message: "The RAW engine changed. Reload saved adjustments to review your edits.") }
                if latest.pending == nil && latest.draft == nil && !self.hasChanges {
                    self.applyRecipe(remote)
                    var refreshed = latest; refreshed.recipe = remote; refreshed.accessed = Date()
                    try await cache.persist(refreshed, origin: api.baseURL)
                } else if remote.revision != latest.recipe.revision {
                    throw RawEditError(message: "This photo was edited elsewhere. Your adjustments are kept; resolve the conflict before sharing.")
                }
                self.savedRevision = latest.pending == nil ? remote.revision : latest.recipe.revision
                if let data = download.data {
                    guard download.engine == self.engine else { throw PhotoBrainAPIError.invalidResponse }
                    let renderer = SmartRawEditRenderer()
                    try await renderer.open(data: data, cancellation: self.localToken)
                    guard self.id == id else { return }
                    self.local = renderer
                    var updated = await cache.entry(api.baseURL, entry.rawID) ?? latest
                    updated.token = download.token; updated.photo = photo
                    try await cache.store(data, entry: updated, origin: api.baseURL)
                }
                self.storageMessage = latest.pending == nil ? "Available offline" : "Saved on device · Waiting to sync"
                self.requestRender()
            } catch {
                guard let self, self.id == id, !Task.isCancelled else { return }
                if Self.canQueue(error) { self.storageMessage = "Offline · Edits stay on this device" }
                else { self.errorMessage = error.localizedDescription }
            }
        }
    }

    private func persistDraft() {
        guard isLocal, let rawID else { return }
        let settings = settings, previous = journalTask
        journalTask = Task { [weak self, api, cache] in
            await previous?.value
            do { try await cache.updateDraft(origin: api.baseURL, rawID: rawID, settings: settings) }
            catch { self?.errorMessage = "Couldn’t store adjustments on this device: \(error.localizedDescription)" }
        }
    }

    private static func canQueue(_ error: Error) -> Bool {
        if case .transport = error as? PhotoBrainAPIError { return true }
        if case let .server(status, _, _) = error as? PhotoBrainAPIError, status >= 500 { return true }
        return (error as? PhotoBrainAPIError)?.isRetryable == true || error is URLError
    }

    func set(_ control: RawEditControl, value: Double) {
        guard isReady, !isSaving, controls.contains(control) else { return }
        control.set(value, in: &settings)
        showingBefore = false
        showImage()
        persistDraft()
        requestRender()
    }

    func reset() {
        guard isReady, !isSaving else { return }
        settings = RawEditSettings()
        persistDraft()
        showingBefore = false
        showImage()
        requestRender()
    }

    func setDragging(_ value: Bool) {
        guard isReady, !isSaving else { return }
        dragging = value
        requestRender()
    }

    func toggleBefore() {
        guard isReady else { return }
        showingBefore.toggle()
        showImage()
    }

    func save() async -> Bool {
        guard isReady, !isSaving, let id, let rawID else { return false }
        isSaving = true
        errorMessage = nil
        defer { if self.id == id { isSaving = false } }
        do {
            await journalTask?.value
            let saved: RawEditRecipe
            if isLocal {
                try await cache.queue(origin: api.baseURL, rawID: rawID, settings: settings)
                savedSettings = settings
                storageMessage = "Saved on device · Waiting to sync"
                guard var synced = try await cache.sync(api: api, rawID: rawID) else { return false }
                if await cache.entry(api.baseURL, rawID)?.pending != nil,
                   let newest = try await cache.sync(api: api, rawID: rawID) { synced = newest }
                guard await cache.entry(api.baseURL, rawID)?.pending == nil else { return false }
                saved = synced
            } else {
                saved = try await api.saveRawEdit(photoId: rawID, settings: settings, revision: savedRevision)
            }
            guard self.id == id else { return false }
            savedSettings = saved.settings
            savedRevision = saved.revision
            return true
        } catch {
            guard self.id == id else { return false }
            if isLocal && Self.canQueue(error) {
                storageMessage = "Saved on device · Will sync when online"
                errorMessage = nil
            } else { errorMessage = error.localizedDescription }
            return false
        }
    }

    func reloadSavedAdjustments() async {
        guard let rawID, let id, !isSaving else { return }
        isSaving = true
        defer { if self.id == id { isSaving = false } }
        do {
            _ = try await api.rawEdit(photoId: rawID) // Keep the local journal if unreachable.
            await journalTask?.value
            guard let entry = await cache.entry(api.baseURL, rawID), self.id == id else { return }
            try await cache.remove(origin: api.baseURL, rawID: rawID)
            start(entry.photo)
        } catch { if self.id == id { errorMessage = error.localizedDescription } }
    }

    func discard() {
        let previous = journalTask
        if isLocal, let rawID {
            journalTask = Task { [api, cache] in
                await previous?.value
                try? await cache.updateDraft(origin: api.baseURL, rawID: rawID, settings: nil)
            }
        }
        end()
    }

    private func showImage() {
        guard let photoID, let image = showingBefore ? beforeImage : currentImage else { return }
        images = [photoID: image]
    }

    private static func decode(_ result: DevelopedRawImage) async throws -> UIImage {
        let image = await Task.detached(priority: .userInitiated) {
            UIImage(data: result.data)?.preparingForDisplay()
        }.value
        guard let image else { throw RawEditError(message: "Couldn’t display the RAW preview") }
        return image
    }

    private static func preview(api: any PhotoBrainAPI, rawID: Int, settings: RawEditSettings, refined: Bool) async throws -> DevelopedRawImage {
        var attempts = 0
        while true {
            do { return try await api.rawEditPreview(photoId: rawID, settings: settings, refined: refined) }
            catch {
                guard (error as? PhotoBrainAPIError)?.code == "DEVELOP_BUSY", attempts < 5 else { throw error }
                attempts += 1
                try await Task.sleep(for: .seconds(1))
            }
        }
    }

    private func requestRender() {
        revision &+= 1
        guard renderTask == nil, let id, let rawID, isReady else { return }
        isRendering = true
        errorMessage = nil
        renderTask = Task { [weak self, api] in
            defer {
                if self?.id == id {
                    self?.renderTask = nil
                    self?.isRendering = false
                }
            }
            while let self, self.id == id, !Task.isCancelled {
                let requested = self.revision
                let settings = self.settings
                let refined = !self.dragging
                do {
                    let image: UIImage
                    if let local = self.local {
                        image = try await local.render(settings, refined: refined, cancellation: self.localToken)
                    } else {
                        let result = try await Self.preview(api: api, rawID: rawID, settings: settings, refined: refined)
                        image = try await Self.decode(result)
                    }
                    guard self.id == id, !Task.isCancelled else { return }
                    if requested == self.revision || self.dragging {
                        self.currentImage = image
                        self.appliedSettings = settings
                        self.showImage()
                    }
                    if requested == self.revision { return }
                } catch {
                    guard self.id == id, !Task.isCancelled else { return }
                    // Keep the draft and last usable frame so a transient network error is recoverable.
                    self.errorMessage = error.localizedDescription
                    return
                }
            }
        }
    }

    func retryPreview() { if isReady { requestRender() } }

    func end() {
        localToken.cancel()
        localToken = RawEditCancellation()
        local = nil
        refreshTask?.cancel()
        refreshTask = nil
        isLocal = false
        storageMessage = nil
        openTask?.cancel()
        renderTask?.cancel()
        id = nil
        photoID = nil
        rawID = nil
        openTask = nil
        renderTask = nil
        revision &+= 1
        dragging = false
        settings = RawEditSettings()
        savedSettings = RawEditSettings()
        savedRevision = 0
        appliedSettings = RawEditSettings()
        beforeImage = nil
        currentImage = nil
        images = [:]
        errorMessage = nil
        isRendering = false
        isSaving = false
        showingBefore = false
        supportsTone = false
        engine = ""
        phase = .inactive
    }

    deinit { openTask?.cancel(); renderTask?.cancel() }
}

struct SmartPreviewDownload: Sendable {
    let data: Data?
    let token: String
    let engine: String
}

/// Application Support keeps previews and tiny draft journals together across restarts.
/// Every origin has its own namespace. Eviction never removes a draft or queued save.
actor SmartPreviewCache {
    static let shared = SmartPreviewCache()
    struct Entry: Codable, Sendable {
        var photo: PhotoRecord
        var rawID: Int
        var recipe: RawEditRecipe
        var token: String
        var draft: RawEditSettings?
        var pending: RawEditSettings?
        var accessed: Date
        var generation: Date? { photo.thumbnailUpdatedAt }
    }
    private let root: URL
    private let limit: Int
    private var syncs: [String: Task<RawEditRecipe, Error>] = [:]

    init(root: URL? = nil, limit: Int = 512 * 1024 * 1024) {
        self.root = root ?? FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0].appendingPathComponent("SmartPreviews-v1")
        self.limit = limit
    }
    private func directory(_ origin: URL) -> URL {
        let key = SHA256.hash(data: Data(origin.absoluteString.utf8)).map { String(format: "%02x", $0) }.joined()
        return root.appendingPathComponent(key)
    }
    private func metadata(_ origin: URL, _ rawID: Int) -> URL { directory(origin).appendingPathComponent("\(rawID).json") }
    func file(_ origin: URL, _ rawID: Int) -> URL { directory(origin).appendingPathComponent("\(rawID).pbsp") }
    func entry(_ origin: URL, _ rawID: Int) -> Entry? {
        guard let data = try? Data(contentsOf: metadata(origin, rawID)) else { return nil }
        return try? JSONDecoder().decode(Entry.self, from: data)
    }
    func entries(_ origin: URL) -> [Entry] {
        let paths = (try? FileManager.default.contentsOfDirectory(at: directory(origin), includingPropertiesForKeys: nil)) ?? []
        return paths.filter { $0.pathExtension == "json" }.compactMap { path in
            guard let data = try? Data(contentsOf: path) else { return nil }
            return try? JSONDecoder().decode(Entry.self, from: data)
        }
    }
    func persist(_ entry: Entry, origin: URL) throws {
        try FileManager.default.createDirectory(at: directory(origin), withIntermediateDirectories: true)
        try JSONEncoder().encode(entry).write(to: metadata(origin, entry.rawID), options: .atomic)
    }
    func store(_ data: Data, entry: Entry, origin: URL) throws {
        guard data.count <= 96 * 1024 * 1024 + 20 else { throw RawEditError(message: "Smart preview is too large") }
        let fm = FileManager.default
        let others = entries(origin).filter { $0.rawID != entry.rawID }.sorted { $0.accessed < $1.accessed }
        func bytes(_ other: Entry) -> Int { ((try? fm.attributesOfItem(atPath: file(origin, other.rawID).path)[.size]) as? NSNumber)?.intValue ?? 0 }
        var required = data.count + others.reduce(0) { $0 + bytes($1) }
        let removable = others.filter { $0.draft == nil && $0.pending == nil }
        guard required - removable.reduce(0, { $0 + bytes($1) }) <= limit else {
            throw RawEditError(message: "Smart preview storage is full. Sync your saved edits before downloading more previews.")
        }
        for other in removable where required > limit {
            required -= bytes(other)
            try? fm.removeItem(at: file(origin, other.rawID))
            try? fm.removeItem(at: metadata(origin, other.rawID))
        }
        try FileManager.default.createDirectory(at: directory(origin), withIntermediateDirectories: true)
        try data.write(to: file(origin, entry.rawID), options: .atomic)
        try persist(entry, origin: origin)
        try evict(origin: origin, keeping: entry.rawID)
    }
    func remove(origin: URL, rawID: Int) async throws {
        if let sync = syncs[origin.absoluteString + ":\(rawID)"] { _ = try? await sync.value }
        let fm = FileManager.default
        for path in [file(origin, rawID), metadata(origin, rawID)] where fm.fileExists(atPath: path.path) {
            try fm.removeItem(at: path)
        }
    }
    func updateDraft(origin: URL, rawID: Int, settings: RawEditSettings?) throws {
        guard var entry = entry(origin, rawID) else { return }
        entry.draft = settings
        entry.accessed = Date()
        try persist(entry, origin: origin)
    }
    func queue(origin: URL, rawID: Int, settings: RawEditSettings) throws {
        guard var entry = entry(origin, rawID) else { throw RawEditError(message: "Download a smart preview before saving offline") }
        entry.pending = settings
        entry.draft = nil
        try persist(entry, origin: origin)
    }
    func evict(origin: URL, keeping: Int? = nil) throws {
        let fm = FileManager.default
        let all = entries(origin).sorted { $0.accessed < $1.accessed }
        func bytes(_ entry: Entry) -> Int { ((try? fm.attributesOfItem(atPath: file(origin, entry.rawID).path)[.size]) as? NSNumber)?.intValue ?? 0 }
        var total = all.reduce(0) { $0 + bytes($1) }
        for entry in all where total > limit && entry.rawID != keeping && entry.draft == nil && entry.pending == nil {
            total -= bytes(entry)
            try? fm.removeItem(at: file(origin, entry.rawID))
            try? fm.removeItem(at: metadata(origin, entry.rawID))
        }
    }
    func cachedPhotos(origin: URL) -> [PhotoRecord] {
        entries(origin).filter { FileManager.default.fileExists(atPath: file(origin, $0.rawID).path) }.map(\.photo).sorted { $0.id > $1.id }
    }
    /// A shared in-flight task prevents editor/foreground/export from racing one save.
    func sync(api: any PhotoBrainAPI, rawID: Int) async throws -> RawEditRecipe? {
        let origin = api.baseURL
        let key = origin.absoluteString + ":\(rawID)"
        if let task = syncs[key] { return try await task.value }
        guard let entry = entry(origin, rawID), let pending = entry.pending else { return nil }
        let task = Task {
            let remote = try await api.rawEdit(photoId: rawID)
            guard remote.engine == entry.recipe.engine else { throw RawEditError(message: "The RAW engine changed. Your offline adjustments are kept; reload saved adjustments to review them.") }
            let saved: RawEditRecipe
            if remote.settings == pending {
                saved = remote // Includes a lost save response.
            } else {
                guard remote.revision == entry.recipe.revision else { throw RawEditError(message: "This photo was edited elsewhere. Your offline adjustments are kept; reload saved adjustments to resolve the conflict.") }
                saved = try await api.saveRawEdit(photoId: rawID, settings: pending, revision: remote.revision)
            }
            // Every waiter sees the committed journal, including export's sync barrier.
            if var current = self.entry(origin, rawID) {
                current.recipe = saved
                if current.pending == pending { current.pending = nil }
                try self.persist(current, origin: origin)
            }
            return saved
        }
        syncs[key] = task
        defer { syncs[key] = nil }
        return try await task.value
    }

    func syncAll(api: any PhotoBrainAPI) async {
        for entry in entries(api.baseURL) where entry.pending != nil { _ = try? await sync(api: api, rawID: entry.rawID) }
    }
}

/// Uses the same Rust full-quality colour/tone renderer, with already prepared pixels.
actor SmartRawEditRenderer {
    private var session: OpaquePointer?
    func open(data: Data, cancellation: RawEditCancellation) throws {
        var error = PBRAWError()
        let opened = data.withUnsafeBytes { bytes in
            pbraw_open_smart_preview(bytes.bindMemory(to: UInt8.self).baseAddress, bytes.count, cancellation.handle, &error)
        }
        guard let opened else { throw RawEditError.take(&error) }
        if let session { pbraw_session_free(session) }
        session = opened
    }
    func render(_ settings: RawEditSettings, refined: Bool, cancellation: RawEditCancellation) throws -> UIImage {
        guard let session else { throw CancellationError() }
        var error = PBRAWError()
        guard let output = pbraw_render_basic(session, settings.exposure, Int32(settings.contrast), Int32(settings.highlights), Int32(settings.shadows), Int32(settings.whites), Int32(settings.blacks), refined ? 1 : 0, cancellation.handle, &error) else { throw RawEditError.take(&error) }
        defer { pbraw_image_free(output) }
        let w = pbraw_image_width(output), h = pbraw_image_height(output)
        guard let pixels = pbraw_image_pixels(output), w > 0, h > 0,
              let space = CGColorSpace(name: CGColorSpace.displayP3),
              let provider = CGDataProvider(data: Data(bytes: pixels, count: pbraw_image_len(output)) as CFData),
              let image = CGImage(width: w, height: h, bitsPerComponent: 8, bitsPerPixel: 32, bytesPerRow: w * 4, space: space,
                                  bitmapInfo: CGBitmapInfo(rawValue: CGImageAlphaInfo.last.rawValue), provider: provider, decode: nil, shouldInterpolate: true, intent: .defaultIntent) else { throw RawEditError(message: "Couldn’t display the smart preview") }
        return UIImage(cgImage: image)
    }
    deinit { if let session { pbraw_session_free(session) } }
}
