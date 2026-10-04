import Foundation
import Photos

/// `BackupPhotoLibrary` over PhotoKit: read-only camera-roll access.
final class PhotoKitBackupLibrary: NSObject, BackupPhotoLibrary, PHPhotoLibraryChangeObserver, @unchecked Sendable {
    private let lock = NSLock()
    private var onChange: (@Sendable () -> Void)?
    private var registered = false

    func authorizationStatus() -> BackupAuthorization {
        Self.map(PHPhotoLibrary.authorizationStatus(for: .readWrite))
    }

    func requestAuthorization() async -> BackupAuthorization {
        Self.map(await PHPhotoLibrary.requestAuthorization(for: .readWrite))
    }

    func assets(includeVideos: Bool) -> [BackupAsset] {
        let options = PHFetchOptions()
        options.sortDescriptors = [NSSortDescriptor(key: "creationDate", ascending: false)]
        options.includeAssetSourceTypes = [.typeUserLibrary, .typeiTunesSynced, .typeCloudShared]
        options.predicate = includeVideos
            ? NSPredicate(
                format: "mediaType == %d || mediaType == %d",
                PHAssetMediaType.image.rawValue,
                PHAssetMediaType.video.rawValue
            )
            : NSPredicate(format: "mediaType == %d", PHAssetMediaType.image.rawValue)
        let result = PHAsset.fetchAssets(with: options)
        var assets: [BackupAsset] = []
        assets.reserveCapacity(result.count)
        result.enumerateObjects { asset, _, _ in
            let resources = PHAssetResource.assetResources(for: asset).map { resource in
                BackupAssetResource(kind: Self.kind(resource.type), filename: resource.originalFilename)
            }
            assets.append(BackupAsset(
                id: asset.localIdentifier,
                creationDate: asset.creationDate,
                isVideo: asset.mediaType == .video,
                resources: resources
            ))
        }
        return assets
    }

    func export(_ item: BackupItem, to file: URL) async throws {
        guard let asset = PHAsset.fetchAssets(withLocalIdentifiers: [item.assetId], options: nil).firstObject else {
            throw BackupExportError.assetMissing
        }
        let resources = PHAssetResource.assetResources(for: asset)
        guard let resource = resources.first(where: {
            Self.kind($0.type) == item.sourceKind && $0.originalFilename == item.filename
        }) ?? resources.first(where: { Self.kind($0.type) == item.sourceKind }) else {
            throw BackupExportError.resourceMissing
        }
        let options = PHAssetResourceRequestOptions()
        options.isNetworkAccessAllowed = true
        try await PHAssetResourceManager.default().writeData(for: resource, toFile: file, options: options)
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

    private static func map(_ status: PHAuthorizationStatus) -> BackupAuthorization {
        switch status {
        case .notDetermined: .notDetermined
        case .restricted: .restricted
        case .denied: .denied
        case .limited: .limited
        case .authorized: .authorized
        @unknown default: .denied
        }
    }

    private static func kind(_ type: PHAssetResourceType) -> PhotoKitResourceKind {
        switch type {
        case .photo: .photo
        case .fullSizePhoto: .fullSizePhoto
        case .alternatePhoto: .alternatePhoto
        case .video: .video
        case .pairedVideo: .pairedVideo
        default: .other
        }
    }
}

enum BackupExportError: LocalizedError {
    case assetMissing
    case resourceMissing

    var errorDescription: String? {
        switch self {
        case .assetMissing: "The photo is no longer in the library."
        case .resourceMissing: "The original file is no longer available."
        }
    }
}
