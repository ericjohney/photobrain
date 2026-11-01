import CoreGraphics
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

/// A server-rendered edit session. Only Save writes the recipe. Intermediate slider positions
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
    var isActive: Bool { phase != .inactive }
    var isReady: Bool { phase == .ready }
    var hasChanges: Bool { settings != savedSettings }
    var label: String {
        if showingBefore { return "Before adjustments" }
        switch phase {
        case .inactive: return "Embedded preview"
        case .loading: return "Preparing RAW…"
        case .ready: return isRendering ? "Updating preview…" : "RAW adjustments"
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

    init(api: any PhotoBrainAPI) { self.api = api }

    func start(_ photo: PhotoRecord) {
        end()
        guard let rawID = LoupeRendition.developableRawID(for: photo) else { return }
        let id = UUID()
        self.id = id
        self.photoID = photo.id
        self.rawID = rawID
        phase = .loading
        openTask = Task { [weak self, api] in
            do {
                let recipe = try await api.rawEdit(photoId: rawID)
                let baseline = try await Self.preview(api: api, rawID: rawID, settings: RawEditSettings(), refined: true)
                let image = try await Self.decode(baseline)
                guard !Task.isCancelled, let self, self.id == id else { return }
                self.savedSettings = recipe.settings
                self.savedRevision = recipe.revision
                self.settings = recipe.settings
                self.supportsTone = recipe.supportsTone
                self.engine = recipe.engine
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

    func set(_ control: RawEditControl, value: Double) {
        guard isReady, !isSaving, controls.contains(control) else { return }
        control.set(value, in: &settings)
        showingBefore = false
        showImage()
        requestRender()
    }

    func reset() {
        guard isReady, !isSaving else { return }
        settings = RawEditSettings()
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
            let saved = try await api.saveRawEdit(photoId: rawID, settings: settings, revision: savedRevision)
            guard self.id == id else { return false }
            savedSettings = saved.settings
            savedRevision = saved.revision
            return true
        } catch {
            guard self.id == id else { return false }
            errorMessage = error.localizedDescription
            return false
        }
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
                    let result = try await Self.preview(api: api, rawID: rawID, settings: settings, refined: refined)
                    let image = try await Self.decode(result)
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
