import CoreLocation
import Foundation

/// Identity of one Library cell. A photo on this device is `.local(assetId)` for as long as the
/// device has it, before and after it reaches the server, so backing up never moves the
/// selection or the open loupe page. `.remote(photoId)` is a server photo with no asset here.
enum LibraryEntryID: Hashable, Sendable, Comparable, CustomStringConvertible {
    case remote(Int)
    case local(String)

    var remotePhotoID: Int? {
        if case let .remote(id) = self { return id }
        return nil
    }

    var description: String {
        switch self {
        case let .remote(id): "remote:\(id)"
        case let .local(assetID): "local:\(assetID)"
        }
    }

    /// Deterministic tiebreak: server photos by id, then device assets by identifier.
    static func < (lhs: Self, rhs: Self) -> Bool {
        switch (lhs, rhs) {
        case let (.remote(l), .remote(r)): l < r
        case let (.local(l), .local(r)): l < r
        case (.remote, .local): true
        case (.local, .remote): false
        }
    }
}

/// One camera-roll asset as the Library shows it; PhotoKit's lightweight properties only.
struct LocalAsset: Hashable, Sendable {
    /// `PHAsset.localIdentifier`.
    let id: String
    let creationDate: Date?
    let pixelWidth: Int
    let pixelHeight: Int
    let isVideo: Bool
    /// Video length; nil for stills.
    let durationMs: Int?
    let latitude: Double?
    let longitude: Double?

    init(
        id: String,
        creationDate: Date?,
        pixelWidth: Int = 0,
        pixelHeight: Int = 0,
        isVideo: Bool = false,
        durationMs: Int? = nil,
        latitude: Double? = nil,
        longitude: Double? = nil
    ) {
        self.id = id
        self.creationDate = creationDate
        self.pixelWidth = pixelWidth
        self.pixelHeight = pixelHeight
        self.isVideo = isVideo
        self.durationMs = durationMs
        self.latitude = latitude
        self.longitude = longitude
    }

    /// The capture date as wall-clock time in the GMT capture calendar, like EXIF dates, so
    /// device and server photos sort and group together. Uses the device's current zone.
    func wallClockDate(in timeZone: TimeZone = .autoupdatingCurrent) -> Date? {
        creationDate.map { $0.addingTimeInterval(TimeInterval(timeZone.secondsFromGMT(for: $0))) }
    }

    var coordinate: PhotoCoordinate? {
        guard let latitude, let longitude else { return nil }
        return PhotoCoordinate(latitude: latitude, longitude: longitude)
    }
}

/// Where a device asset's backup stands, from the backup ledger.
enum LocalBackupState: Hashable, Sendable {
    /// Backup is off, or the asset has nothing the server accepts.
    case notBackedUp
    /// Waiting its turn in the backup queue.
    case queued
    case uploading
    /// Stored on the server; becomes a server photo with the next import.
    case uploaded
    /// A retry is pending or the server rejected a file.
    case failed

    /// Grid badge symbol.
    var systemImage: String {
        switch self {
        case .notBackedUp: "iphone"
        case .queued: "arrow.up.circle"
        case .uploading: "arrow.up.circle.fill"
        case .uploaded: "icloud.and.arrow.up"
        case .failed: "exclamationmark.icloud"
        }
    }

    var accessibilityText: String {
        switch self {
        case .notBackedUp: "On this iPhone only"
        case .queued: "Waiting to back up"
        case .uploading: "Backing up"
        case .uploaded: "Backed up, importing"
        case .failed: "Backup failed"
        }
    }

    var title: String {
        switch self {
        case .notBackedUp: "Not Backed Up"
        case .queued: "Waiting to Back Up"
        case .uploading: "Backing Up…"
        case .uploaded: "Importing on Server"
        case .failed: "Backup Failed"
        }
    }
}

/// One Library cell: a server photo, a device asset, or both when the asset was backed up and
/// imported. Server features (curation, collections, faces, tags, export) need `remote`.
struct LibraryEntry: Identifiable, Hashable, Sendable {
    let id: LibraryEntryID
    var remote: PhotoRecord?
    let local: LocalAsset?
    /// Backup progress of a device-only asset; nil once the server photo is attached.
    var backupState: LocalBackupState?

    init(remote: PhotoRecord) {
        id = .remote(remote.id)
        self.remote = remote
        local = nil
        backupState = nil
    }

    init(local: LocalAsset, remote: PhotoRecord?, backupState: LocalBackupState? = nil) {
        id = .local(local.id)
        self.remote = remote
        self.local = local
        self.backupState = remote == nil ? (backupState ?? .notBackedUp) : nil
    }

    /// On this device and not (yet) a server photo.
    var isDeviceOnly: Bool { remote == nil }

    var rating: Int { remote?.rating ?? 0 }
    var flag: PhotoFlag? { remote?.flag }
    var isRejected: Bool { remote?.isRejected ?? false }
    var isVideo: Bool { remote?.isVideo ?? local?.isVideo ?? false }
    var formatBadge: String? { remote?.formatBadge }

    var mediaBadge: MediaBadge? {
        if let remote { return remote.mediaBadge }
        // Device-only Live Photos show as stills: their motion clip plays once backed up.
        guard let local, local.isVideo else { return nil }
        return .video(durationMs: local.durationMs)
    }

    /// Capture date in the GMT capture calendar, for sorting, grouping, and titles.
    var captureDate: Date {
        if let remote { return PhotoDateResolver.date(for: remote) }
        return local?.wallClockDate() ?? .distantPast
    }

    var accessibilityName: String {
        if let remote { return remote.accessibilityName }
        let kind = local?.isVideo == true ? "Video" : "Photo"
        let date = captureDate.formatted(
            Date.FormatStyle(date: .abbreviated, time: .shortened, timeZone: PhotoDateResolver.calendar.timeZone)
        )
        let name = "\(kind), \(date)"
        return mediaBadge.map { "\(name), \($0.accessibilityText)" } ?? name
    }
}

/// Which Library filters a device-only asset can be checked against without the server.
enum LocalFilterSupport {
    /// `true`/`false` when `filters` can be evaluated on the device; nil when they need server
    /// data (camera, tags, places, curation, …), in which case device-only assets are hidden.
    static func matches(_ asset: LocalAsset, filters: LibraryFilters) -> Bool? {
        var rest = filters
        rest.mediaKind = .all
        guard !rest.isActive else { return nil }
        switch filters.mediaKind {
        case .all: return true
        case .standard: return !asset.isVideo
        case .video: return asset.isVideo
        case .raw: return nil
        }
    }
}

/// Combines a server listing with the device's assets so each moment appears once.
enum LibraryMerge {
    /// - A device asset mapped to a listed server photo becomes `.local(assetId)` carrying that
    ///   photo; the server photo is not listed again. When several assets map to one photo (the
    ///   same bytes saved twice), only the first in `assets` order is shown.
    /// - Any other asset (unmapped, or mapped to a photo the listing lacks because it is stale
    ///   or the photo was removed) is a device-only cell when `includeDeviceOnly` and the filters
    ///   can be evaluated on the device and match it. Under server-only filters it is hidden: the
    ///   server may have filtered it out.
    /// - Every other listed server photo is `.remote(photoId)`.
    static func merge(
        remote: [PhotoRecord],
        assets: [LocalAsset],
        photoIDsByAsset: [String: Int],
        filters: LibraryFilters,
        includeDeviceOnly: Bool,
        backupState: (String) -> LocalBackupState = { _ in .notBackedUp }
    ) -> [LibraryEntry] {
        var remoteByID: [Int: PhotoRecord] = [:]
        remoteByID.reserveCapacity(remote.count)
        for record in remote { remoteByID[record.id] = record }
        var claimed: Set<Int> = []
        var entries: [LibraryEntry] = []
        entries.reserveCapacity(remote.count + assets.count)
        for asset in assets {
            if let photoID = photoIDsByAsset[asset.id] {
                if claimed.contains(photoID) { continue }
                if let record = remoteByID[photoID] {
                    claimed.insert(photoID)
                    entries.append(LibraryEntry(local: asset, remote: record))
                    continue
                }
            }
            if includeDeviceOnly, LocalFilterSupport.matches(asset, filters: filters) == true {
                entries.append(LibraryEntry(local: asset, remote: nil, backupState: backupState(asset.id)))
            }
        }
        for record in remote where !claimed.contains(record.id) {
            entries.append(LibraryEntry(remote: record))
        }
        return entries
    }
}
