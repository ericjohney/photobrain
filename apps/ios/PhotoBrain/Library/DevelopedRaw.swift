import Foundation
import UIKit

/// `GET /api/photos/{id}/developed`: JPEG bytes and the size from `X-Developed-Width/Height`.
struct DevelopedRawImage: Sendable {
    let data: Data
    let width: Int?
    let height: Int?
}

/// The current viewer preview, reported in Photo Info.
enum LoupeRendition: Equatable {
    case embedded
    case developing
    case developed(width: Int, height: Int)
    /// The develop failed; the embedded preview stays on screen.
    case failed(String)

    var infoValue: String {
        switch self {
        case .embedded: "Standard preview"
        case .developing: "Loading…"
        case let .developed(width, height): "\(width) × \(height) px"
        case let .failed(message): "Standard preview (\(message))"
        }
    }

    /// The RAW to develop for `photo`: itself when it is a converted RAW, else the RAW
    /// partner of a stacked RAW+JPEG pair; nil for videos and other stills.
    static func developableRawID(for photo: PhotoRecord?) -> Int? {
        guard let photo, !photo.isVideo else { return nil }
        if photo.isRaw { return photo.isConvertedRAW ? photo.id : nil }
        return photo.pairedPhotoId
    }

    static func editableRawID(for photo: PhotoRecord?) -> Int? {
        guard let photo, let id = developableRawID(for: photo) else { return nil }
        let format = photo.isRaw ? (photo.filename as NSString).pathExtension : photo.pairedFormat
        return ["RAF", "ARW", "DNG"].contains(format?.uppercased() ?? "") ? id : nil
    }

    static func failureMessage(_ error: Error) -> String {
        if case let .server(_, code, message) = error as? PhotoBrainAPIError {
            switch code {
            case "DEVELOP_UNSUPPORTED": return "Not available for this camera"
            case "DEVELOP_BUSY": return "Server busy, try again"
            case "DEVELOP_UNAVAILABLE": return "Not enabled on the server"
            default: return message
            }
        }
        return (error as? LocalizedError)?.errorDescription ?? "Couldn’t develop"
    }
}

/// Loads the saved preview for the open photo. Paging away cancels the request.
@MainActor
final class LoupeDevelopedStore: ObservableObject {
    /// 503 `DEVELOP_BUSY` retries before giving up.
    static let maxBusyRetries = 5

    /// The decoded render by photo id (at most one: the open photo's).
    @Published private(set) var images: [Int: UIImage] = [:]
    @Published private(set) var rendition: LoupeRendition = .embedded

    @Published private(set) var waitingToSync = false
    private let cache: SmartPreviewCache
    private let api: any PhotoBrainAPI
    private let busyDelay: Duration
    private var task: Task<Void, Never>?
    private var currentPhotoID: Int?
    private var currentThumbnailUpdatedAt: Date?

    init(api: any PhotoBrainAPI, busyDelay: Duration = .seconds(1), cache: SmartPreviewCache = .shared) {
        self.cache = cache
        self.api = api
        self.busyDelay = busyDelay
    }

    func show(_ photo: PhotoRecord?, force: Bool = false) {
        let rawID = LoupeRendition.developableRawID(for: photo)
        guard force || photo?.id != currentPhotoID || photo?.thumbnailUpdatedAt != currentThumbnailUpdatedAt || rawID == nil else { return }
        currentThumbnailUpdatedAt = photo?.thumbnailUpdatedAt
        currentPhotoID = photo?.id
        task?.cancel()
        task = nil
        images = [:]
        waitingToSync = false
        guard let photo, let rawID else {
            rendition = .embedded
            return
        }
        rendition = .developing
        task = Task { [weak self, api, busyDelay, cache] in
            let entry = await cache.entry(api.baseURL, rawID)
            guard !Task.isCancelled else { return }
            self?.waitingToSync = entry?.pending != nil
            if let entry, entry.generation == photo.thumbnailUpdatedAt, entry.pending != nil || entry.locallySaved == true {
                do {
                    let url = await cache.file(api.baseURL, rawID)
                    let image = try await Self.savedPreview(entry, file: url)
                    guard !Task.isCancelled, let self, self.currentPhotoID == photo.id else { return }
                    self.images = [photo.id: image]
                    self.rendition = .developed(width: Int(image.size.width), height: Int(image.size.height))
                    return
                } catch {
                    guard !Task.isCancelled else { return }
                    if entry.pending != nil {
                        self?.rendition = .failed("Local preview unavailable")
                        return
                    }
                }
            }
            guard !Task.isCancelled else { return }
            // Server-rendered edits have no smart-preview file. Keep showing the saved
            // frame until the background job publishes this photo’s new generation.
            if case let .saved(image) = await cache.savedThumbnail(for: photo) {
                guard !Task.isCancelled, let self, self.currentPhotoID == photo.id else { return }
                self.images = [photo.id: image]
                self.rendition = .developed(width: Int(image.size.width), height: Int(image.size.height))
                return
            }
            guard !Task.isCancelled else { return }
            var attempt = 0
            while true {
                do {
                    let result = try await api.developedRaw(photoId: rawID)
                    let image = await Task.detached(priority: .userInitiated) {
                        UIImage(data: result.data)?.preparingForDisplay()
                    }.value
                    guard !Task.isCancelled, let self, self.currentPhotoID == photo.id else { return }
                    guard let image else {
                        self.rendition = .failed("Couldn’t decode the render")
                        return
                    }
                    self.images = [photo.id: image]
                    self.rendition = .developed(
                        width: result.width ?? Int(image.size.width * image.scale),
                        height: result.height ?? Int(image.size.height * image.scale)
                    )
                    return
                } catch is CancellationError {
                    return
                } catch {
                    if (error as? PhotoBrainAPIError)?.code == "DEVELOP_BUSY", attempt < Self.maxBusyRetries {
                        attempt += 1
                        try? await Task.sleep(for: busyDelay)
                        if Task.isCancelled { return }
                        continue
                    }
                    guard !Task.isCancelled, let self, self.currentPhotoID == photo.id else { return }
                    self.rendition = .failed(LoupeRendition.failureMessage(error))
                    return
                }
            }
        }
    }

    /// Recreate the saved image even after an offline relaunch. Unsaved drafts belong to the editor.
    private static func savedPreview(_ entry: SmartPreviewCache.Entry, file: URL) async throws -> UIImage {
        let settings = entry.pending ?? entry.recipe.settings
        guard settings.denoiseAmount == (entry.previewDenoise ?? entry.recipe.settings.denoiseAmount) else {
            throw RawEditError(message: "Local preview uses different Denoise settings")
        }
        let data = try await Task.detached { try Data(contentsOf: file, options: .mappedIfSafe) }.value
        try Task.checkCancellation()
        let renderer = SmartRawEditRenderer()
        let token = RawEditCancellation()
        return try await withTaskCancellationHandler {
            try await renderer.open(data: data, cancellation: token)
            return try await renderer.render(settings, refined: true, cancellation: token)
        } onCancel: { token.cancel() }
    }

    /// Cancels the render and releases its image (loupe dismissal).
    func release() {
        task?.cancel()
        task = nil
        currentPhotoID = nil
        waitingToSync = false
        images = [:]
        rendition = .embedded
    }
}
