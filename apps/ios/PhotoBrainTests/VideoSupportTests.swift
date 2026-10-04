import AVFoundation
import XCTest
@testable import PhotoBrain

private let baseURL = URL(string: "https://photos.example.test")!

private func photoJSON(_ extra: String = "") -> Data {
    let common = #""id":5,"path":"synthetic/IMG_0005.MOV","name":"IMG_0005.MOV","size":2048,"createdAt":"2024-01-02T03:04:05.000Z","modifiedAt":"2024-01-02T03:04:06Z","isRaw":false"#
    return Data("{\(common)\(extra)}".utf8)
}

private func makeRecord(
    id: Int,
    mediaType: PhotoMediaType = .photo,
    durationMs: Int? = nil,
    videoCodec: String? = nil,
    motionVideoId: Int? = nil,
    name: String? = nil
) -> PhotoRecord {
    var dto = TestModels.photo(id: id, name: name)
    dto.mediaType = mediaType
    dto.durationMs = durationMs
    dto.videoCodec = videoCodec
    dto.motionVideoId = motionVideoId
    return PhotoRecord(dto: dto, apiBaseURL: baseURL)
}

final class VideoDurationTests: XCTestCase {
    func testTextFloorsToWholeSecondsAcrossMinuteAndHourBoundaries() {
        let cases: [(Int?, String)] = [
            (nil, "0:00"),
            (-1, "0:00"),
            (-60_000, "0:00"),
            (0, "0:00"),
            (999, "0:00"),
            (1_000, "0:01"),
            (59_900, "0:59"),
            (59_999, "0:59"),
            (60_000, "1:00"),
            (65_000, "1:05"),
            (599_999, "9:59"),
            (600_000, "10:00"),
            (3_599_999, "59:59"),
            (3_600_000, "1:00:00"),
            (3_661_000, "1:01:01"),
            (36_000_000, "10:00:00"),
        ]
        for (milliseconds, expected) in cases {
            XCTAssertEqual(
                VideoDuration.text(milliseconds: milliseconds),
                expected,
                "\(String(describing: milliseconds)) ms"
            )
        }
    }

    func testSpokenTextFloorsPluralizesAndOmitsZeroComponents() {
        let cases: [(Int?, String?)] = [
            (nil, nil),
            (-5_000, "0 seconds"),
            (0, "0 seconds"),
            (999, "0 seconds"),
            (1_000, "1 second"),
            (59_900, "59 seconds"),
            (60_000, "1 minute"),
            (65_000, "1 minute 5 seconds"),
            (121_000, "2 minutes 1 second"),
            (3_600_000, "1 hour"),
            (3_602_000, "1 hour 2 seconds"),
            (7_260_000, "2 hours 1 minute"),
        ]
        for (milliseconds, expected) in cases {
            XCTAssertEqual(
                VideoDuration.spokenText(milliseconds: milliseconds),
                expected,
                "\(String(describing: milliseconds)) ms"
            )
        }
    }

    func testMediaBadgeForVideosLiveStillsAndPlainStills() {
        let video = MediaBadge(mediaType: .video, durationMs: 65_400, motionVideoID: nil)
        XCTAssertEqual(video, .video(durationMs: 65_400))
        XCTAssertEqual(video?.text, "1:05")
        XCTAssertEqual(video?.accessibilityText, "Video, 1 minute 5 seconds")

        let unknownLength = MediaBadge(mediaType: .video, durationMs: nil, motionVideoID: nil)
        XCTAssertEqual(unknownLength?.text, "0:00")
        XCTAssertEqual(unknownLength?.accessibilityText, "Video")

        // A video never gets LIVE, even if a server sent a motion id on it.
        XCTAssertEqual(MediaBadge(mediaType: .video, durationMs: 3_000, motionVideoID: 9), .video(durationMs: 3_000))

        let live = MediaBadge(mediaType: .photo, durationMs: nil, motionVideoID: 9)
        XCTAssertEqual(live, .live)
        XCTAssertEqual(live?.text, "LIVE")
        XCTAssertEqual(live?.accessibilityText, "Live Photo")

        XCTAssertNil(MediaBadge(mediaType: .photo, durationMs: nil, motionVideoID: nil))
    }

    func testGridAccessibilityNameAppendsMediaDescriptionAfterFormat() {
        XCTAssertEqual(
            makeRecord(id: 1, mediaType: .video, durationMs: 65_000, name: "IMG_0001.MOV").accessibilityName,
            "IMG_0001.MOV, Video, 1 minute 5 seconds"
        )
        XCTAssertEqual(
            makeRecord(id: 2, motionVideoId: 3, name: "IMG_0002.HEIC").accessibilityName,
            "IMG_0002.HEIC, Live Photo"
        )
        XCTAssertEqual(makeRecord(id: 4, name: "IMG_0004.JPG").accessibilityName, "IMG_0004.JPG")
    }
}

final class VideoDTOTests: XCTestCase {
    func testVideoFieldsDecodeAndMapToRecordURLs() throws {
        let dto = try APIModelCoding.decoder().decode(
            PhotoDTO.self,
            from: photoJSON(#","mediaType":"video","durationMs":65000,"videoCodec":"hevc","motionVideoId":null"#)
        )
        XCTAssertEqual(dto.mediaType, .video)
        XCTAssertEqual(dto.durationMs, 65_000)
        XCTAssertEqual(dto.videoCodec, "hevc")
        XCTAssertNil(dto.motionVideoId)

        let record = PhotoRecord(dto: dto, apiBaseURL: baseURL)
        XCTAssertTrue(record.isVideo)
        XCTAssertEqual(record.fileURL.absoluteString, "https://photos.example.test/api/photos/5/file")
        XCTAssertNil(record.motionVideoURL)
    }

    func testLiveStillExposesItsMotionClipFileRoute() throws {
        let dto = try APIModelCoding.decoder().decode(
            PhotoDTO.self,
            from: photoJSON(#","mediaType":"photo","durationMs":null,"videoCodec":null,"motionVideoId":42"#)
        )
        XCTAssertEqual(dto.motionVideoId, 42)
        let record = PhotoRecord(dto: dto, apiBaseURL: baseURL)
        XCTAssertFalse(record.isVideo)
        XCTAssertEqual(record.motionVideoURL?.absoluteString, "https://photos.example.test/api/photos/42/file")
        XCTAssertEqual(record.fileURL.absoluteString, "https://photos.example.test/api/photos/5/file")
    }

    func testServersWithoutVideoFieldsDecodeAsPlainPhotos() throws {
        let legacy = try APIModelCoding.decoder().decode(PhotoDTO.self, from: photoJSON())
        XCTAssertEqual(legacy.mediaType, .photo)
        XCTAssertNil(legacy.durationMs)
        XCTAssertNil(legacy.videoCodec)
        XCTAssertNil(legacy.motionVideoId)

        let nullType = try APIModelCoding.decoder().decode(PhotoDTO.self, from: photoJSON(#","mediaType":null"#))
        XCTAssertEqual(nullType.mediaType, .photo)
        let unknownType = try APIModelCoding.decoder().decode(PhotoDTO.self, from: photoJSON(#","mediaType":"hologram""#))
        XCTAssertEqual(unknownType.mediaType, .photo)
    }

    func testVideoFieldsRoundTripThroughEncoding() throws {
        let original = try APIModelCoding.decoder().decode(
            PhotoDTO.self,
            from: photoJSON(#","mediaType":"video","durationMs":1500,"videoCodec":"h264""#)
        )
        let decoded = try APIModelCoding.decoder().decode(PhotoDTO.self, from: APIModelCoding.encoder().encode(original))
        XCTAssertEqual(decoded, original)
    }
}

final class MediaKindVideoQueryTests: XCTestCase {
    func testVideoKindSerializesIntoPhotosQueryAndSearchBody() throws {
        let query = PhotoQuery(filterRaw: .video, camera: "iPhone 15 Pro")
        XCTAssertEqual(
            query.queryItems,
            [URLQueryItem(name: "filterRaw", value: "video"), URLQueryItem(name: "camera", value: "iPhone 15 Pro")]
        )

        let body = try XCTUnwrap(
            JSONSerialization.jsonObject(
                with: APIModelCoding.encoder().encode(SearchRequestDTO(query: "dog", limit: 10, filters: query))
            ) as? [String: Any]
        )
        XCTAssertEqual(body["filterRaw"] as? String, "video")
    }

    func testVideoKindIsPickableActiveAndClearable() {
        XCTAssertEqual(LibraryFilters.MediaKind.allCases, [.all, .raw, .standard, .video])
        XCTAssertEqual(LibraryFilters.MediaKind.video.title, "Video")

        let filters = LibraryFilters().selectingMediaKind(.video)
        XCTAssertEqual(filters.photoQuery.filterRaw, .video)
        XCTAssertEqual(filters.mediaPickerSelection, .video)
        XCTAssertEqual(filters.activeFields.map(\.title), ["Video"])
        XCTAssertEqual(filters.removing(.mediaKind), LibraryFilters())
    }

    func testSmartAlbumCriteriaRoundTripVideoKind() throws {
        let criteria = SmartAlbumFilters(LibraryFilters().selectingMediaKind(.video))
        XCTAssertEqual(criteria.filterRaw, .video)
        let encoded = try APIModelCoding.encoder().encode(criteria)
        XCTAssertEqual(
            try JSONSerialization.jsonObject(with: encoded) as? [String: String],
            ["filterRaw": "video"]
        )
        XCTAssertEqual(try APIModelCoding.decoder().decode(SmartAlbumFilters.self, from: encoded), criteria)
    }
}

@MainActor
final class LoupePlaybackControllerTests: XCTestCase {
    /// Records every call; `finish()` simulates AVPlayerItem reaching its end.
    private final class FakePlayer: LoupePlayer {
        let url: URL
        let muted: Bool
        private let onEnded: @MainActor () -> Void
        private(set) var calls: [String] = []
        var avPlayer: AVPlayer? { nil }

        init(url: URL, muted: Bool, onEnded: @escaping @MainActor () -> Void) {
            self.url = url
            self.muted = muted
            self.onEnded = onEnded
        }

        var isPlaying: Bool { calls.last == "play" }
        var isReleased: Bool { calls.contains("release") }

        func play() { calls.append("play") }
        func pause() { calls.append("pause") }
        func release() { calls.append("release") }
        func finish() { onEnded() }
    }

    private var created: [FakePlayer] = []

    private func makeController() -> LoupePlaybackController {
        created = []
        return LoupePlaybackController { [unowned self] url, muted, onEnded in
            let player = FakePlayer(url: url, muted: muted, onEnded: onEnded)
            created.append(player)
            return player
        }
    }

    private let video = makeRecord(id: 1, mediaType: .video, durationMs: 65_000, videoCodec: "hevc")
    private let otherVideo = makeRecord(id: 2, mediaType: .video, durationMs: 4_000)
    private let liveStill = makeRecord(id: 3, motionVideoId: 30)
    private let plainStill = makeRecord(id: 4)

    func testVideoPageAppearancePreparesAPausedUnmutedPlayerUntilReady() throws {
        let controller = makeController()
        controller.show(video)

        XCTAssertEqual(controller.state, .video(photoID: 1, readyForDisplay: false))
        let player = try XCTUnwrap(created.first)
        XCTAssertTrue(controller.player === player)
        XCTAssertEqual(player.url, video.fileURL)
        XCTAssertFalse(player.muted)
        XCTAssertFalse(player.isPlaying)
        XCTAssertEqual(player.calls, [])

        controller.playerReadyForDisplay(photoID: 1)
        XCTAssertEqual(controller.state, .video(photoID: 1, readyForDisplay: true))
        XCTAssertFalse(player.isPlaying)
    }

    func testReShowingTheSamePageKeepsItsPlayer() {
        let controller = makeController()
        controller.show(video)
        controller.playerReadyForDisplay(photoID: 1)
        controller.show(video)

        XCTAssertEqual(created.count, 1)
        XCTAssertFalse(created[0].isReleased)
        XCTAssertEqual(controller.state, .video(photoID: 1, readyForDisplay: true))
    }

    func testPageChangePausesAndReleasesThePreviousPlayer() {
        let controller = makeController()
        controller.show(video)
        created[0].play()
        controller.show(otherVideo)

        XCTAssertEqual(created[0].calls, ["play", "pause", "release"])
        XCTAssertEqual(created.count, 2)
        XCTAssertTrue(controller.player === created[1])
        XCTAssertEqual(controller.state, .video(photoID: 2, readyForDisplay: false))

        controller.show(plainStill)
        XCTAssertEqual(created[1].calls, ["pause", "release"])
        XCTAssertNil(controller.player)
        XCTAssertEqual(controller.state, .still(photoID: 4, hasMotion: false))
    }

    func testDismissalPausesAndReleasesAndAllowsReopeningTheSamePage() {
        let controller = makeController()
        controller.show(video)
        controller.release()

        XCTAssertEqual(created[0].calls, ["pause", "release"])
        XCTAssertNil(controller.player)
        XCTAssertEqual(controller.state, .inactive)

        controller.show(video)
        XCTAssertEqual(created.count, 2)
        XCTAssertEqual(controller.state, .video(photoID: 1, readyForDisplay: false))
    }

    func testStaleReadinessForAnotherPageIsIgnored() {
        let controller = makeController()
        controller.show(video)
        controller.show(otherVideo)
        controller.playerReadyForDisplay(photoID: 1)
        XCTAssertEqual(controller.state, .video(photoID: 2, readyForDisplay: false))
    }

    func testLiveTapPlaysMotionMutedOnceThenEndReturnsToStill() throws {
        let controller = makeController()
        controller.show(liveStill)
        XCTAssertEqual(controller.state, .still(photoID: 3, hasMotion: true))
        XCTAssertTrue(created.isEmpty, "A still prepares no player until LIVE")

        controller.playLive()
        let clip = try XCTUnwrap(created.first)
        XCTAssertEqual(clip.url, liveStill.motionVideoURL)
        XCTAssertTrue(clip.muted)
        XCTAssertEqual(clip.calls, ["play"])
        XCTAssertEqual(controller.state, .live(photoID: 3, readyForDisplay: false))
        XCTAssertTrue(controller.isPlayingLive)

        controller.playerReadyForDisplay(photoID: 3)
        XCTAssertEqual(controller.state, .live(photoID: 3, readyForDisplay: true))

        clip.finish()
        XCTAssertEqual(controller.state, .still(photoID: 3, hasMotion: true))
        XCTAssertEqual(clip.calls, ["play", "pause", "release"])
        XCTAssertNil(controller.player)
        XCTAssertFalse(controller.isPlayingLive)

        // It can be replayed after returning to the still.
        controller.playLive()
        XCTAssertEqual(created.count, 2)
        XCTAssertEqual(controller.state, .live(photoID: 3, readyForDisplay: false))
    }

    func testLiveTapWhilePlayingIsIgnored() {
        let controller = makeController()
        controller.show(liveStill)
        controller.playLive()
        controller.playLive()

        XCTAssertEqual(created.count, 1)
        XCTAssertEqual(created[0].calls, ["play"])
        XCTAssertEqual(controller.state, .live(photoID: 3, readyForDisplay: false))
    }

    func testLiveTapWithoutMotionClipOrOnVideoIsIgnored() {
        let controller = makeController()
        controller.show(plainStill)
        controller.playLive()
        XCTAssertTrue(created.isEmpty)
        XCTAssertEqual(controller.state, .still(photoID: 4, hasMotion: false))

        controller.show(video)
        controller.playLive()
        XCTAssertEqual(created.count, 1)
        XCTAssertEqual(controller.state, .video(photoID: 1, readyForDisplay: false))
    }

    func testPageChangeDuringLiveReleasesClipAndItsLateEndIsIgnored() {
        let controller = makeController()
        controller.show(liveStill)
        controller.playLive()
        let clip = created[0]
        controller.show(plainStill)

        XCTAssertEqual(clip.calls, ["play", "pause", "release"])
        clip.finish()
        XCTAssertEqual(controller.state, .still(photoID: 4, hasMotion: false))

        // A late end from the released clip must not cut short a replay on the returned page.
        controller.show(liveStill)
        controller.playLive()
        clip.finish()
        XCTAssertEqual(controller.state, .live(photoID: 3, readyForDisplay: false))
    }

    func testVideoEndKeepsTheVideoPageAndPlayer() {
        let controller = makeController()
        controller.show(video)
        controller.playerReadyForDisplay(photoID: 1)
        created[0].play()
        created[0].finish()

        XCTAssertEqual(controller.state, .video(photoID: 1, readyForDisplay: true))
        XCTAssertFalse(created[0].isReleased)
    }
}

final class VideoShareOptionTests: XCTestCase {
    func testVideosOfferOnlyTheOriginal() {
        let options = PhotoShareOption.options(for: makeRecord(id: 1, mediaType: .video, durationMs: 5_000))
        XCTAssertEqual(options.map(\.title), ["Share Video"])
        XCTAssertEqual(options.map(\.size), [.original])
    }

    func testStillsIncludingLivePhotosOfferJPEGAndOriginal() {
        for still in [makeRecord(id: 2), makeRecord(id: 3, motionVideoId: 30)] {
            let options = PhotoShareOption.options(for: still)
            XCTAssertEqual(options.map(\.title), ["Share Photo", "Share Original"])
            XCTAssertEqual(options.map(\.size), [.jpeg2048, .original])
        }
    }
}
