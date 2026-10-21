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

/// One transient loupe edit. Source files are downloaded through the original export route
/// (the /file route can return an embedded JPEG for a RAW). Nothing is written to the source
/// or catalog. Paging, dismissal, backgrounding and memory warnings release the session.
@MainActor
final class LoupeRawEditStore: ObservableObject {
    enum Phase: Equatable {
        case inactive, downloading, preparing, ready, failed(String)
    }

    @Published private(set) var phase: Phase = .inactive
    @Published private(set) var images: [Int: UIImage] = [:]
    @Published private(set) var exposure = 0.0
    @Published private(set) var progress: Double?
    @Published private(set) var appliedExposure = 0.0
    @Published private(set) var lastRenderMilliseconds: Double?
    var isActive: Bool { phase != .inactive }
    var isReady: Bool { phase == .ready }

    var label: String {
        switch phase {
        case .inactive: "Embedded preview"
        case .downloading: progress.map { "Downloading RAW · \(Int($0 * 100))%" } ?? "Downloading RAW…"
        case .preparing: "Preparing RAW…"
        case .ready: "On-device RAW preview"
        case .failed: "RAW edit unavailable"
        }
    }

    private let api: any PhotoBrainAPI
    private let renderer: any RawEditRendering
    private var id: UUID?
    private var photoID: Int?
    private var cancellation: RawEditCancellation?
    private var openTask: Task<Void, Never>?
    private var renderTask: Task<Void, Never>?
    private var revision = 0
    private var dragging = false

    init(api: any PhotoBrainAPI, renderer: any RawEditRendering = NativeRawEditRenderer()) {
        self.api = api
        self.renderer = renderer
    }

    func start(_ photo: PhotoRecord) {
        end()
        guard let rawID = LoupeRendition.developableRawID(for: photo) else { return }
        let id = UUID()
        let token = RawEditCancellation()
        self.id = id
        photoID = photo.id
        cancellation = token
        phase = .downloading
        openTask = Task { [weak self, api, renderer] in
            do {
                let file = try await api.download(.photo(id: rawID, size: .original)) { [weak self] update in
                    Task { @MainActor [weak self] in
                        guard let self, self.id == id, self.phase == .downloading else { return }
                        self.progress = update.fraction
                    }
                }
                defer { file.remove() }
                try Task.checkCancellation()
                guard let self, self.id == id else { return }
                self.phase = .preparing
                try await renderer.open(file: file.url, id: id, cancellation: token)
                guard !Task.isCancelled, self.id == id else {
                    await renderer.release(id: id)
                    return
                }
                self.phase = .ready
                self.requestRender()
            } catch {
                await renderer.release(id: id)
                guard !Task.isCancelled, let self, self.id == id else { return }
                self.phase = .failed(error.localizedDescription)
            }
        }
    }

    func setExposure(_ value: Double) {
        guard isReady, value.isFinite else { return }
        exposure = min(3, max(-3, value))
        requestRender()
    }

    func setDragging(_ dragging: Bool) {
        guard isReady else { return }
        self.dragging = dragging
        requestRender()
    }

    private func requestRender() {
        revision &+= 1
        guard renderTask == nil, let id, let photoID, let cancellation, isReady else { return }
        renderTask = Task { [weak self, renderer] in
            defer { if self?.id == id { self?.renderTask = nil } }
            while let self, self.id == id, !Task.isCancelled {
                let requested = self.revision
                let exposure = self.exposure
                let refined = !self.dragging
                do {
                    let frame = try await renderer.render(
                        id: id, exposure: exposure, refined: refined, cancellation: cancellation
                    )
                    guard self.id == id, !Task.isCancelled else { return }
                    // Completed frames advance in order during a drag. Intermediate settings
                    // are coalesced; an obsolete frame is suppressed once the finger lifts.
                    if requested == self.revision || self.dragging {
                        self.images = [photoID: UIImage(cgImage: frame.image)]
                        self.appliedExposure = exposure
                        self.lastRenderMilliseconds = frame.milliseconds
                    }
                    if requested == self.revision { return }
                } catch {
                    guard self.id == id, !Task.isCancelled else { return }
                    self.phase = .failed(error.localizedDescription)
                    await renderer.release(id: id)
                    return
                }
            }
        }
    }

    func end() {
        cancellation?.cancel()
        openTask?.cancel()
        renderTask?.cancel()
        if let id { Task { [renderer] in await renderer.release(id: id) } }
        id = nil
        photoID = nil
        cancellation = nil
        openTask = nil
        renderTask = nil
        revision &+= 1
        dragging = false
        exposure = 0
        appliedExposure = 0
        lastRenderMilliseconds = nil
        images = [:]
        progress = nil
        phase = .inactive
    }

    deinit {
        cancellation?.cancel()
        openTask?.cancel()
        renderTask?.cancel()
        if let id { Task { [renderer] in await renderer.release(id: id) } }
    }
}
