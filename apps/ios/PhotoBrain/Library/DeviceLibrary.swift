import AVFoundation
import Foundation
import Photos
import UIKit

/// The device's camera roll as the Library shows it; PhotoKit in the app, a fake in tests.
protocol LocalAssetLibrary: AnyObject, Sendable {
    /// True when Photos access allows reading (full or limited).
    func canRead() -> Bool
    /// Whether the user has not been asked for Photos access yet.
    func canRequestAccess() -> Bool
    /// Asks for Photos access; true when reading is allowed afterwards.
    func requestAccess() async -> Bool
    /// Every image and video asset, newest first.
    func assets() -> [LocalAsset]
    /// Calls `onChange` (on any queue) after the camera roll changes.
    func startObserving(_ onChange: @escaping @Sendable () -> Void)
    func stopObserving()
}

/// `GET /uploads/assets`: the server photos of this device's uploaded assets.
protocol UploadedAssetsAPI: Sendable {
    func uploadedAssets(deviceId: String, after: String?, limit: Int?) async throws -> UploadedAssetsResponseDTO
}

/// Camera-roll asset id to server photo id, for assets this device backed up and the server
/// imported. Persisted as JSON with the paging cursor, so a refresh only fetches new imports.
/// Imports get increasing photo ids, so resuming after the last seen entry is complete; a full
/// refresh (`reset`) also drops entries for photos the server since removed.
final class AssetPhotoMap: @unchecked Sendable {
    private struct Stored: Codable {
        var deviceId: String
        var photoIDs: [String: Int]
        var cursor: String?
    }

    private let fileURL: URL?
    private let lock = NSLock()
    private var stored: Stored

    init(fileURL: URL?, deviceId: String) {
        self.fileURL = fileURL
        let loaded = fileURL
            .flatMap { try? Data(contentsOf: $0) }
            .flatMap { try? JSONDecoder().decode(Stored.self, from: $0) }
        if let loaded, loaded.deviceId == deviceId {
            stored = loaded
        } else {
            stored = Stored(deviceId: deviceId, photoIDs: [:], cursor: nil)
        }
    }

    var deviceId: String { lock.withLock { stored.deviceId } }
    var photoIDsByAsset: [String: Int] { lock.withLock { stored.photoIDs } }
    var cursor: String? { lock.withLock { stored.cursor } }

    /// Fetches every page after the stored cursor (all pages when `reset`), merging them in.
    /// Returns true when the map changed.
    @discardableResult
    func refresh(api: any UploadedAssetsAPI, reset: Bool = false) async throws -> Bool {
        let deviceId = deviceId
        var cursor = reset ? nil : cursor
        var fetched: [String: Int] = [:]
        repeat {
            let page = try await api.uploadedAssets(deviceId: deviceId, after: cursor, limit: nil)
            try Task.checkCancellation()
            for asset in page.assets { fetched[asset.assetId] = asset.photoId }
            if let next = page.nextCursor {
                cursor = next
            } else {
                if let last = page.assets.last { cursor = "\(last.photoId):\(last.assetId)" }
                break
            }
        } while true
        let finalCursor = cursor
        let changed = lock.withLock {
            let previous = stored.photoIDs
            if reset {
                stored.photoIDs = fetched
            } else {
                stored.photoIDs.merge(fetched) { _, new in new }
            }
            stored.cursor = finalCursor
            return stored.photoIDs != previous
        }
        save()
        return changed
    }

    private func save() {
        guard let fileURL else { return }
        let data = lock.withLock { try? JSONEncoder().encode(stored) }
        guard let data else { return }
        try? FileManager.default.createDirectory(
            at: fileURL.deletingLastPathComponent(),
            withIntermediateDirectories: true
        )
        try? data.write(to: fileURL, options: .atomic)
    }
}

/// Where each device asset's backup stands; the Library badges device-only cells with it.
@MainActor
protocol BackupStateProviding: AnyObject {
    func backupState(assetId: String) -> LocalBackupState
}

/// The Library's device source: the camera roll, which of its assets the server has imported,
/// and the user's Show setting. Publishes `revision` whenever the merged Library must rebuild.
@MainActor
final class DeviceLibrary: ObservableObject {
    /// Library Options › Show.
    enum Visibility: String, CaseIterable, Identifiable, Sendable {
        /// Server photos plus device photos not yet imported.
        case all
        /// Only photos on this device.
        case device
        /// Only server photos, as before device photos were shown.
        case server

        var id: Self { self }
        var title: String {
            switch self {
            case .all: "All Photos"
            case .device: "On This iPhone"
            case .server: "On Server"
            }
        }
    }

    static let visibilityKey = "com.photobrain.libraryVisibility"
    /// Server lookups run at most this often outside explicit refreshes.
    static let refreshInterval: TimeInterval = 30

    @Published private(set) var assets: [LocalAsset] = []
    @Published private(set) var photoIDsByAsset: [String: Int] = [:]
    @Published private(set) var revision = 0
    @Published var visibility: Visibility {
        didSet {
            guard visibility != oldValue else { return }
            defaults.set(visibility.rawValue, forKey: Self.visibilityKey)
            revision &+= 1
        }
    }

    /// Optional backup progress for device-only badges; nil shows `notBackedUp`.
    weak var backupStates: (any BackupStateProviding)?

    private let library: any LocalAssetLibrary
    private let api: (any UploadedAssetsAPI)?
    private let map: AssetPhotoMap
    private let defaults: UserDefaults
    private let now: () -> Date
    private var observing = false
    private var lastServerRefresh: Date?
    private var serverTask: Task<Void, Never>?
    private var reloadTask: Task<Void, Never>?

    init(
        library: any LocalAssetLibrary,
        api: (any UploadedAssetsAPI)?,
        map: AssetPhotoMap,
        defaults: UserDefaults = .standard,
        now: @escaping () -> Date = Date.init
    ) {
        self.library = library
        self.api = api
        self.map = map
        self.defaults = defaults
        self.now = now
        visibility = defaults.string(forKey: Self.visibilityKey).flatMap(Visibility.init(rawValue:)) ?? .all
        photoIDsByAsset = map.photoIDsByAsset
    }

    /// True when the camera roll is readable; device photos are shown only then.
    var isAvailable: Bool { library.canRead() }

    /// True until the user has answered the Photos access prompt.
    var canRequestAccess: Bool { library.canRequestAccess() }

    /// Asks for Photos access, then loads the camera roll when granted.
    func requestAccess() async {
        guard await library.requestAccess() else {
            revision &+= 1
            return
        }
        await reload(force: true)
        revision &+= 1
    }

    func backupState(assetId: String) -> LocalBackupState {
        backupStates?.backupState(assetId: assetId) ?? .notBackedUp
    }

    /// Re-reads the camera roll (when readable) and refreshes the server mapping. `force`
    /// skips the refresh interval (pull to refresh, a finished import).
    func reload(force: Bool = false) async {
        guard library.canRead() else {
            if !assets.isEmpty {
                assets = []
                revision &+= 1
            }
            return
        }
        startObservingIfNeeded()
        await reloadAssets()
        await refreshServerMapping(force: force)
    }

    /// Fetches newly imported uploads; a full refresh when `reset`.
    func refreshServerMapping(force: Bool = false, reset: Bool = false) async {
        guard let api else { return }
        let current = now()
        if !force, !reset, let last = lastServerRefresh, current.timeIntervalSince(last) < Self.refreshInterval {
            return
        }
        lastServerRefresh = current
        let map = map
        do {
            let changed = try await map.refresh(api: api, reset: reset)
            if changed {
                photoIDsByAsset = map.photoIDsByAsset
                revision &+= 1
            }
        } catch {
            // Offline: keep the cached mapping; device photos still show.
        }
    }

    /// Backup state changed (an upload finished); rebuild so badges update.
    func backupStatesChanged() {
        revision &+= 1
    }

    private func reloadAssets() async {
        let library = library
        let loaded = await Task.detached(priority: .userInitiated) { library.assets() }.value
        guard loaded != assets else { return }
        assets = loaded
        revision &+= 1
    }

    private func startObservingIfNeeded() {
        guard !observing else { return }
        observing = true
        library.startObserving { [weak self] in
            Task { @MainActor in self?.scheduleAssetReload() }
        }
    }

    /// Coalesces bursts of camera-roll changes.
    private func scheduleAssetReload() {
        reloadTask?.cancel()
        reloadTask = Task { [weak self] in
            try? await Task.sleep(for: .milliseconds(500))
            guard !Task.isCancelled else { return }
            await self?.reloadAssets()
        }
    }
}

/// `LocalAssetLibrary` over PhotoKit: read-only camera-roll access.
final class PhotoKitAssetLibrary: NSObject, LocalAssetLibrary, PHPhotoLibraryChangeObserver, @unchecked Sendable {
    private let lock = NSLock()
    private var onChange: (@Sendable () -> Void)?
    private var registered = false

    func canRead() -> Bool {
        switch PHPhotoLibrary.authorizationStatus(for: .readWrite) {
        case .authorized, .limited: true
        default: false
        }
    }

    func canRequestAccess() -> Bool {
        PHPhotoLibrary.authorizationStatus(for: .readWrite) == .notDetermined
    }

    func requestAccess() async -> Bool {
        switch await PHPhotoLibrary.requestAuthorization(for: .readWrite) {
        case .authorized, .limited: true
        default: false
        }
    }

    func assets() -> [LocalAsset] {
        let options = PHFetchOptions()
        options.sortDescriptors = [NSSortDescriptor(key: "creationDate", ascending: false)]
        options.includeAssetSourceTypes = [.typeUserLibrary, .typeiTunesSynced, .typeCloudShared]
        options.predicate = NSPredicate(
            format: "mediaType == %d || mediaType == %d",
            PHAssetMediaType.image.rawValue,
            PHAssetMediaType.video.rawValue
        )
        let result = PHAsset.fetchAssets(with: options)
        var assets: [LocalAsset] = []
        assets.reserveCapacity(result.count)
        result.enumerateObjects { asset, _, _ in
            let isVideo = asset.mediaType == .video
            assets.append(LocalAsset(
                id: asset.localIdentifier,
                creationDate: asset.creationDate,
                pixelWidth: asset.pixelWidth,
                pixelHeight: asset.pixelHeight,
                isVideo: isVideo,
                durationMs: isVideo ? Int((asset.duration * 1_000).rounded(.down)) : nil,
                latitude: asset.location?.coordinate.latitude,
                longitude: asset.location?.coordinate.longitude
            ))
        }
        return assets
    }

    func startObserving(_ onChange: @escaping @Sendable () -> Void) {
        let register = lock.withLock {
            self.onChange = onChange
            defer { registered = true }
            return !registered
        }
        if register { PHPhotoLibrary.shared().register(self) }
    }

    func stopObserving() {
        let unregister = lock.withLock {
            onChange = nil
            defer { registered = false }
            return registered
        }
        if unregister { PHPhotoLibrary.shared().unregisterChangeObserver(self) }
    }

    func photoLibraryDidChange(_ changeInstance: PHChange) {
        lock.withLock { onChange }?()
    }
}

/// Loads camera-roll images for grid cells, filmstrip frames, and loupe pages.
@MainActor
final class LocalImageLoader {
    static let shared = LocalImageLoader()

    private let manager = PHCachingImageManager()

    enum LoadError: Error {
        case missing
        case unavailable
    }

    /// The asset's image at `targetSize` points. `opportunistic` first delivers a degraded
    /// image through `onDegraded`; `networkAllowed` downloads iCloud originals (loupe only).
    func image(
        assetID: String,
        targetSize: CGSize,
        highQuality: Bool,
        networkAllowed: Bool,
        onDegraded: ((UIImage) -> Void)? = nil
    ) async throws -> UIImage {
        guard let asset = PHAsset.fetchAssets(withLocalIdentifiers: [assetID], options: nil).firstObject else {
            throw LoadError.missing
        }
        let scale = UIScreen.main.scale
        let pixelSize = CGSize(width: max(1, targetSize.width * scale), height: max(1, targetSize.height * scale))
        let options = PHImageRequestOptions()
        options.deliveryMode = highQuality ? .highQualityFormat : .opportunistic
        options.resizeMode = .fast
        options.isNetworkAccessAllowed = networkAllowed
        options.version = .current
        let manager = manager
        var requestID: PHImageRequestID = PHInvalidImageRequestID
        return try await withTaskCancellationHandler {
            try await withCheckedThrowingContinuation { continuation in
                var resumed = false
                requestID = manager.requestImage(
                    for: asset,
                    targetSize: pixelSize,
                    contentMode: .aspectFill,
                    options: options
                ) { image, info in
                    MainActor.assumeIsolated {
                        guard !resumed else { return }
                        let degraded = (info?[PHImageResultIsDegradedKey] as? Bool) ?? false
                        if (info?[PHImageCancelledKey] as? Bool) == true {
                            resumed = true
                            continuation.resume(throwing: CancellationError())
                        } else if let image, degraded {
                            onDegraded?(image)
                        } else if let image {
                            resumed = true
                            continuation.resume(returning: image)
                        } else {
                            resumed = true
                            continuation.resume(throwing: LoadError.unavailable)
                        }
                    }
                }
            }
        } onCancel: {
            Task { @MainActor in manager.cancelImageRequest(requestID) }
        }
    }

    func startCaching(assetIDs: [String], targetSize: CGSize) {
        let assets = fetch(assetIDs)
        guard !assets.isEmpty else { return }
        manager.startCachingImages(for: assets, targetSize: pixelSize(targetSize), contentMode: .aspectFill, options: nil)
    }

    func stopCaching(assetIDs: [String], targetSize: CGSize) {
        let assets = fetch(assetIDs)
        guard !assets.isEmpty else { return }
        manager.stopCachingImages(for: assets, targetSize: pixelSize(targetSize), contentMode: .aspectFill, options: nil)
    }

    /// An `AVPlayerItem` for a video asset, downloading from iCloud when needed.
    func playerItem(assetID: String) async -> AVPlayerItem? {
        guard let asset = PHAsset.fetchAssets(withLocalIdentifiers: [assetID], options: nil).firstObject else {
            return nil
        }
        let options = PHVideoRequestOptions()
        options.isNetworkAccessAllowed = true
        options.deliveryMode = .automatic
        return await withCheckedContinuation { continuation in
            PHImageManager.default().requestPlayerItem(forVideo: asset, options: options) { item, _ in
                continuation.resume(returning: item)
            }
        }
    }

    private func fetch(_ ids: [String]) -> [PHAsset] {
        let result = PHAsset.fetchAssets(withLocalIdentifiers: ids, options: nil)
        var assets: [PHAsset] = []
        result.enumerateObjects { asset, _, _ in assets.append(asset) }
        return assets
    }

    private func pixelSize(_ size: CGSize) -> CGSize {
        let scale = UIScreen.main.scale
        return CGSize(width: size.width * scale, height: size.height * scale)
    }
}

/// Writes a device asset's original (the still, or the video) to its own temporary directory.
enum DeviceOriginalExporter {
    enum ExportError: Error {
        case missing
    }

    static func export(assetID: String) async throws -> URL {
        guard let asset = PHAsset.fetchAssets(withLocalIdentifiers: [assetID], options: nil).firstObject else {
            throw ExportError.missing
        }
        let resources = PHAssetResource.assetResources(for: asset)
        let preferred: [PHAssetResourceType] = asset.mediaType == .video
            ? [.fullSizeVideo, .video]
            : [.fullSizePhoto, .photo]
        guard let resource = preferred.lazy.compactMap({ type in resources.first { $0.type == type } }).first
            ?? resources.first else {
            throw ExportError.missing
        }
        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("DeviceShare-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        let name = resource.originalFilename.isEmpty ? "Photo" : resource.originalFilename
        let file = directory.appendingPathComponent(name)
        let options = PHAssetResourceRequestOptions()
        options.isNetworkAccessAllowed = true
        do {
            try await PHAssetResourceManager.default().writeData(for: resource, toFile: file, options: options)
        } catch {
            try? FileManager.default.removeItem(at: directory)
            throw error
        }
        return file
    }
}
