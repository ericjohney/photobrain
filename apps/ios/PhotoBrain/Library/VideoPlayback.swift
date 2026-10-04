import AVFoundation
import Foundation

/// Video length text. Durations are floored to whole seconds (59.9 s is `0:59`); `nil` and
/// negative durations display as `0:00`.
enum VideoDuration {
    /// `m:ss` below one hour, `h:mm:ss` from one hour.
    static func text(milliseconds: Int?) -> String {
        let (hours, minutes, seconds) = components(milliseconds)
        return hours > 0
            ? String(format: "%d:%02d:%02d", hours, minutes, seconds)
            : String(format: "%d:%02d", minutes, seconds)
    }

    /// Spoken length, e.g. "1 hour 2 seconds"; zero components are omitted unless the whole
    /// duration is zero ("0 seconds"). `nil` when the duration is unknown.
    static func spokenText(milliseconds: Int?) -> String? {
        guard milliseconds != nil else { return nil }
        let (hours, minutes, seconds) = components(milliseconds)
        var parts: [String] = []
        if hours > 0 { parts.append(unit(hours, "hour")) }
        if minutes > 0 { parts.append(unit(minutes, "minute")) }
        if seconds > 0 || parts.isEmpty { parts.append(unit(seconds, "second")) }
        return parts.joined(separator: " ")
    }

    private static func components(_ milliseconds: Int?) -> (Int, Int, Int) {
        let total = max(0, milliseconds ?? 0) / 1_000
        return (total / 3_600, total % 3_600 / 60, total % 60)
    }

    private static func unit(_ value: Int, _ name: String) -> String {
        value == 1 ? "1 \(name)" : "\(value) \(name)s"
    }
}

/// Grid overlay for moving media: a video's duration or a Live Photo still's `LIVE` marker.
enum MediaBadge: Equatable, Sendable {
    case video(durationMs: Int?)
    case live

    /// A video always gets its duration badge; a still only when it has a motion clip.
    init?(mediaType: PhotoMediaType, durationMs: Int?, motionVideoID: Int?) {
        switch mediaType {
        case .video: self = .video(durationMs: durationMs)
        case .photo:
            guard motionVideoID != nil else { return nil }
            self = .live
        }
    }

    var text: String {
        switch self {
        case let .video(durationMs): VideoDuration.text(milliseconds: durationMs)
        case .live: "LIVE"
        }
    }

    var systemImage: String {
        switch self {
        case .video: "play.fill"
        case .live: "livephoto"
        }
    }

    /// "Video, 1 minute 5 seconds", "Video" when the length is unknown, or "Live Photo".
    var accessibilityText: String {
        switch self {
        case let .video(durationMs):
            VideoDuration.spokenText(milliseconds: durationMs).map { "Video, \($0)" } ?? "Video"
        case .live:
            "Live Photo"
        }
    }
}

/// The playback surface the loupe drives. `release()` must be the last call: it stops loading
/// and drops the media so a released player holds no network or decoder resources.
@MainActor
protocol LoupePlayer: AnyObject {
    /// The AVFoundation player to render, or nil for test doubles.
    var avPlayer: AVPlayer? { get }
    func play()
    func pause()
    func release()
}

/// AVPlayer over a `/api/photos/{id}/file` URL (HTTP Range seeking is served by the API).
/// Created paused; reports the end of the item through `onEnded`.
@MainActor
final class AVLoupePlayer: LoupePlayer {
    private(set) var avPlayer: AVPlayer?
    private var endObserver: NSObjectProtocol?

    init(url: URL, muted: Bool, onEnded: @escaping @MainActor () -> Void) {
        let item = AVPlayerItem(url: url)
        let player = AVPlayer(playerItem: item)
        player.isMuted = muted
        player.actionAtItemEnd = .pause
        avPlayer = player
        // Muted motion clips mix with other audio; videos take the playback session when played.
        let session = AVAudioSession.sharedInstance()
        if muted {
            try? session.setCategory(.ambient, mode: .default, options: [.mixWithOthers])
        } else {
            try? session.setCategory(.playback, mode: .moviePlayback)
        }
        endObserver = NotificationCenter.default.addObserver(
            forName: AVPlayerItem.didPlayToEndTimeNotification,
            object: item,
            queue: .main
        ) { _ in
            MainActor.assumeIsolated { onEnded() }
        }
    }

    func play() {
        avPlayer?.play()
    }

    func pause() {
        avPlayer?.pause()
    }

    func release() {
        if let endObserver {
            NotificationCenter.default.removeObserver(endObserver)
        }
        endObserver = nil
        avPlayer?.pause()
        avPlayer?.replaceCurrentItem(with: nil)
        avPlayer = nil
    }
}

/// Owns the loupe's single player. At most one player exists, always for the open page:
/// - a video page appears: its player is prepared but paused (`.video`, not ready);
/// - the page changes or the loupe is dismissed: the player is paused and released;
/// - LIVE on a still with a motion clip: the clip plays muted once (`.live`); when it ends the
///   page returns to the still. LIVE is ignored while a clip plays or without a motion clip.
/// `readyForDisplay` turns true once the view shows the first frame; until then the page keeps
/// showing the large thumbnail.
@MainActor
final class LoupePlaybackController: ObservableObject {
    enum State: Equatable {
        case inactive
        case still(photoID: Int, hasMotion: Bool)
        case video(photoID: Int, readyForDisplay: Bool)
        case live(photoID: Int, readyForDisplay: Bool)

        var photoID: Int? {
            switch self {
            case .inactive: nil
            case let .still(id, _), let .video(id, _), let .live(id, _): id
            }
        }
    }

    typealias PlayerFactory = @MainActor (
        _ url: URL,
        _ muted: Bool,
        _ onEnded: @escaping @MainActor () -> Void
    ) -> any LoupePlayer

    /// `player` is always updated before `state`, so `$state` subscribers can read it.
    @Published private(set) var state: State = .inactive
    private(set) var player: (any LoupePlayer)?
    private var page: PhotoRecord?
    /// Bumped per player; end events from released players are ignored.
    private var generation = 0
    private let makePlayer: PlayerFactory

    init(makePlayer: @escaping PlayerFactory = { AVLoupePlayer(url: $0, muted: $1, onEnded: $2) }) {
        self.makePlayer = makePlayer
    }

    var isPlayingLive: Bool {
        if case .live = state { return true }
        return false
    }

    /// The open page changed (or reappeared). Re-showing the current page keeps its player.
    func show(_ photo: PhotoRecord?) {
        if let photo, photo.id == page?.id { return }
        releasePlayer()
        page = photo
        guard let photo else {
            state = .inactive
            return
        }
        if photo.isVideo {
            player = newPlayer(url: photo.fileURL, muted: false)
            state = .video(photoID: photo.id, readyForDisplay: false)
        } else {
            state = .still(photoID: photo.id, hasMotion: photo.motionVideoURL != nil)
        }
    }

    func playLive() {
        guard case let .still(photoID, true) = state, let url = page?.motionVideoURL else { return }
        let live = newPlayer(url: url, muted: true)
        player = live
        state = .live(photoID: photoID, readyForDisplay: false)
        live.play()
    }

    /// The view rendered the first frame of the current player for `photoID`.
    func playerReadyForDisplay(photoID: Int) {
        switch state {
        case .video(photoID, false):
            state = .video(photoID: photoID, readyForDisplay: true)
        case .live(photoID, false):
            state = .live(photoID: photoID, readyForDisplay: true)
        default:
            break
        }
    }

    /// Loupe dismissal: pauses and releases everything.
    func release() {
        releasePlayer()
        page = nil
        state = .inactive
    }

    private func newPlayer(url: URL, muted: Bool) -> any LoupePlayer {
        generation += 1
        let playerGeneration = generation
        return makePlayer(url, muted) { [weak self] in
            self?.playbackEnded(generation: playerGeneration)
        }
    }

    /// Only a motion clip returns to its still; a video stays on its last frame with controls.
    private func playbackEnded(generation endedGeneration: Int) {
        guard endedGeneration == generation, case let .live(photoID, _) = state else { return }
        releasePlayer()
        state = .still(photoID: photoID, hasMotion: true)
    }

    private func releasePlayer() {
        guard let player else { return }
        generation += 1
        self.player = nil
        player.pause()
        player.release()
    }
}
