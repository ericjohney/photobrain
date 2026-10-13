import Foundation
import UIKit

/// `GET /api/photos/{id}/developed`: JPEG bytes and the size from `X-Developed-Width/Height`.
struct DevelopedRawImage: Sendable {
    let data: Data
    let width: Int?
    let height: Int?
}

/// What the loupe shows for a RAW: the stored embedded preview, or a full development.
enum LoupeRendition: Equatable {
    case embedded
    case developing
    case developed(width: Int, height: Int)
    /// The develop failed; the embedded preview stays on screen.
    case failed(String)

    /// The loupe badge text, so the viewer always knows which rendition is shown.
    var label: String {
        switch self {
        case .embedded: "Embedded preview · 1600 px"
        case .developing: "Developing…"
        case let .developed(width, height): "Developed · \(width) × \(height)"
        case let .failed(message): "Embedded preview · \(message)"
        }
    }

    /// The RAW to develop for `photo`: itself when it is a converted RAW, else the RAW
    /// partner of a stacked RAW+JPEG pair; nil for videos and other stills.
    static func developableRawID(for photo: PhotoRecord?) -> Int? {
        guard let photo, !photo.isVideo else { return nil }
        if photo.isRaw { return photo.isConvertedRAW ? photo.id : nil }
        return photo.pairedPhotoId
    }

    /// The badge text for a failed develop.
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

/// Loupe "Show Developed RAW": a persisted preference plus the open photo's render. Only the
/// open photo is developed (on demand, not cached); paging away cancels and drops it.
@MainActor
final class LoupeDevelopedStore: ObservableObject {
    static let preferenceKey = "com.photobrain.loupeShowsDeveloped"
    /// 503 `DEVELOP_BUSY` retries before giving up.
    static let maxBusyRetries = 5

    @Published private(set) var isOn: Bool
    /// The decoded render by photo id (at most one: the open photo's).
    @Published private(set) var images: [Int: UIImage] = [:]
    @Published private(set) var rendition: LoupeRendition = .embedded

    private let api: any PhotoBrainAPI
    private let defaults: UserDefaults
    private let busyDelay: Duration
    private var task: Task<Void, Never>?
    private var currentPhotoID: Int?

    init(api: any PhotoBrainAPI, defaults: UserDefaults = .standard, busyDelay: Duration = .seconds(1)) {
        self.api = api
        self.defaults = defaults
        self.busyDelay = busyDelay
        isOn = defaults.bool(forKey: Self.preferenceKey)
    }

    func setOn(_ on: Bool, photo: PhotoRecord?) {
        isOn = on
        defaults.set(on, forKey: Self.preferenceKey)
        currentPhotoID = nil
        show(photo)
    }

    /// Develops `photo` (when on and developable), replacing any earlier render.
    func show(_ photo: PhotoRecord?) {
        let rawID = isOn ? LoupeRendition.developableRawID(for: photo) : nil
        guard photo?.id != currentPhotoID || rawID == nil else { return }
        currentPhotoID = photo?.id
        task?.cancel()
        task = nil
        images = [:]
        guard let photo, let rawID else {
            rendition = .embedded
            return
        }
        rendition = .developing
        task = Task { [weak self, api, busyDelay] in
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

    /// Cancels the render and releases its image (loupe dismissal).
    func release() {
        task?.cancel()
        task = nil
        currentPhotoID = nil
        images = [:]
        rendition = .embedded
    }
}
