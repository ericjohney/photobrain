import Foundation
import Security

/// The PhotoKit resource types the backup distinguishes; every other type (adjustment data,
/// edited renders, audio) is `other` and never uploaded.
enum PhotoKitResourceKind: String, Codable, Sendable {
    case photo
    case fullSizePhoto
    case alternatePhoto
    case video
    case pairedVideo
    case other
}

struct BackupAssetResource: Equatable, Sendable {
    let kind: PhotoKitResourceKind
    let filename: String
}

/// One camera-roll asset as the planner sees it.
struct BackupAsset: Equatable, Sendable {
    /// `PHAsset.localIdentifier`.
    let id: String
    let creationDate: Date?
    let isVideo: Bool
    let resources: [BackupAssetResource]
}

/// Identity of one uploaded original: the server's idempotency key without the device.
struct BackupItemKey: Hashable, Codable, Sendable {
    let assetId: String
    let resource: UploadResource
}

/// One original file to upload.
struct BackupItem: Equatable, Sendable {
    let assetId: String
    let resource: UploadResource
    /// The PhotoKit resource exported for `resource`.
    let sourceKind: PhotoKitResourceKind
    let filename: String
    let capturedAt: Date?

    var key: BackupItemKey { BackupItemKey(assetId: assetId, resource: resource) }

    /// Lower-case extension with the leading dot, or empty when the filename has none.
    var fileExtension: String {
        let ext = (filename as NSString).pathExtension.lowercased()
        return ext.isEmpty ? "" : "." + ext
    }
}

enum BackupResourceSelector {
    /// The originals of `asset`, in upload order: the still (`.photo`, or `.fullSizePhoto` only
    /// when there is no `.photo`), the RAW alternate, the video, and the Live Photo clip.
    static func items(for asset: BackupAsset) -> [BackupItem] {
        func first(_ kind: PhotoKitResourceKind) -> BackupAssetResource? {
            asset.resources.first { $0.kind == kind }
        }
        let candidates: [(UploadResource, BackupAssetResource?)] = [
            (.photo, first(.photo) ?? first(.fullSizePhoto)),
            (.alternatePhoto, first(.alternatePhoto)),
            (.video, first(.video)),
            (.pairedVideo, first(.pairedVideo)),
        ]
        return candidates.compactMap { resource, source in
            guard let source else { return nil }
            return BackupItem(
                assetId: asset.id,
                resource: resource,
                sourceKind: source.kind,
                filename: source.filename,
                capturedAt: asset.creationDate
            )
        }
    }
}

struct BackupPlan: Equatable, Sendable {
    /// Items still to upload, newest asset first.
    var pending: [BackupItem]
    /// Assets with at least one supported original.
    var totalAssets: Int
    /// Assets whose supported originals are all uploaded.
    var backedUpAssets: Int
    /// Files the server rejected permanently (too large, unsupported, invalid).
    var skippedFiles: Int
    /// Originals whose extension the server does not accept; never uploaded.
    var unsupportedFiles: Int
    /// Remaining (not yet uploaded) supported originals per asset id.
    var remainingByAsset: [String: Int]
}

enum BackupPlanner {
    /// Diffs the library against the local record. Video assets are left out unless
    /// `includeVideos`; a Live Photo's paired clip belongs to its still and is always included.
    /// Items already uploaded, skipped, or in flight are not pending.
    static func plan(
        assets: [BackupAsset],
        includeVideos: Bool,
        extensions: Set<String>,
        ledger: BackupLedger.Snapshot,
        inFlight: Set<BackupItemKey>
    ) -> BackupPlan {
        let ordered = assets.enumerated().sorted { lhs, rhs in
            switch (lhs.element.creationDate, rhs.element.creationDate) {
            case let (l?, r?) where l != r: return l > r
            case (.some, nil): return true
            case (nil, .some): return false
            default: return lhs.offset < rhs.offset
            }
        }
        var plan = BackupPlan(
            pending: [],
            totalAssets: 0,
            backedUpAssets: 0,
            skippedFiles: 0,
            unsupportedFiles: 0,
            remainingByAsset: [:]
        )
        for (_, asset) in ordered {
            if asset.isVideo && !includeVideos { continue }
            var eligible = 0
            var remaining = 0
            for item in BackupResourceSelector.items(for: asset) {
                guard extensions.contains(item.fileExtension) else {
                    plan.unsupportedFiles += 1
                    continue
                }
                eligible += 1
                switch ledger.records[item.key]?.status {
                case .uploaded:
                    continue
                case .skipped:
                    plan.skippedFiles += 1
                    remaining += 1
                case nil:
                    remaining += 1
                    if !inFlight.contains(item.key) { plan.pending.append(item) }
                }
            }
            guard eligible > 0 else { continue }
            plan.totalAssets += 1
            if remaining == 0 {
                plan.backedUpAssets += 1
            } else {
                plan.remainingByAsset[asset.id] = remaining
            }
        }
        return plan
    }
}

enum BackupBackoff {
    static let base: TimeInterval = 30
    static let maximum: TimeInterval = 6 * 60 * 60

    /// 30 s, 60 s, 120 s, … capped at six hours.
    static func delay(attempts: Int) -> TimeInterval {
        let exponent = min(max(attempts - 1, 0), 20)
        return min(base * pow(2, Double(exponent)), maximum)
    }
}

/// Durable record of what this device has uploaded, skipped, has in flight, and must retry.
/// An append-only JSON-lines journal in Application Support: every mutation appends one line,
/// and loading replays and compacts it. Thread-safe; background-session completions update it
/// from the session's delegate queue.
final class BackupLedger: @unchecked Sendable {
    struct Record: Codable, Equatable, Sendable {
        enum Status: String, Codable, Sendable {
            case uploaded
            case skipped
        }

        let status: Status
        /// The library-relative path for uploads (nil when learned from `/uploads/known`), the
        /// reason for skips.
        let detail: String?
    }

    struct Retry: Codable, Equatable, Sendable {
        let attempts: Int
        let failedAt: Date
        let notBefore: Date
        let message: String
    }

    /// An upload handed to the background session. Keyed by `tempName`, which is also the
    /// task's `taskDescription`, so completions delivered after a relaunch find their item.
    struct Transfer: Codable, Equatable, Sendable {
        let key: BackupItemKey
        let filename: String
        /// File name inside the temporary upload directory.
        let tempName: String
    }

    struct Snapshot: Equatable, Sendable {
        var deviceId: String?
        var reconciled = false
        var records: [BackupItemKey: Record] = [:]
        var retries: [BackupItemKey: Retry] = [:]
        var transfers: [String: Transfer] = [:]

        var latestRetry: Retry? { retries.values.max { $0.failedAt < $1.failedAt } }
    }

    enum Event: Codable, Equatable {
        case device(String)
        case reconciled
        case record(BackupItemKey, Record)
        case retry(BackupItemKey, Retry)
        case began(Transfer)
        case ended(String)
    }

    let fileURL: URL
    private let lock = NSLock()
    private var state = Snapshot()
    private var handle: FileHandle?
    private let encoder = JSONEncoder()

    /// Loads the journal. A journal for another device id (or none) starts empty.
    init(fileURL: URL, deviceId: String) {
        self.fileURL = fileURL
        encoder.dateEncodingStrategy = .millisecondsSince1970
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .millisecondsSince1970
        var lines = 0
        var needsCompaction = false
        if let data = try? Data(contentsOf: fileURL), !data.isEmpty {
            needsCompaction = data.last != UInt8(ascii: "\n")
            for line in data.split(separator: UInt8(ascii: "\n"), omittingEmptySubsequences: true) {
                lines += 1
                guard let event = try? decoder.decode(Event.self, from: line) else {
                    needsCompaction = true
                    continue
                }
                Self.apply(event, to: &state)
            }
        }
        if state.deviceId != deviceId {
            state = Snapshot(deviceId: deviceId)
            needsCompaction = true
        }
        let live = state.records.count + state.retries.count + state.transfers.count + 2
        if needsCompaction || lines > live * 2 + 64 {
            compact()
        }
    }

    deinit {
        try? handle?.close()
    }

    var snapshot: Snapshot { lock.withLock { state } }

    var isReconciled: Bool { lock.withLock { state.reconciled } }

    var transfers: [String: Transfer] { lock.withLock { state.transfers } }

    var retries: [BackupItemKey: Retry] { lock.withLock { state.retries } }

    func record(for key: BackupItemKey) -> Record? { lock.withLock { state.records[key] } }

    func retry(for key: BackupItemKey) -> Retry? { lock.withLock { state.retries[key] } }

    func record(_ key: BackupItemKey, _ record: Record) {
        append(.record(key, record))
    }

    /// Records the resources `/uploads/known` reported and marks the device reconciled.
    func reconcile(known keys: [BackupItemKey]) {
        lock.withLock {
            for key in keys where state.records[key]?.status != .uploaded {
                appendLocked(.record(key, Record(status: .uploaded, detail: nil)))
            }
            appendLocked(.reconciled)
        }
    }

    @discardableResult
    func recordRetry(_ key: BackupItemKey, message: String, now: Date) -> Retry {
        lock.withLock {
            let attempts = (state.retries[key]?.attempts ?? 0) + 1
            let retry = Retry(
                attempts: attempts,
                failedAt: now,
                notBefore: now.addingTimeInterval(BackupBackoff.delay(attempts: attempts)),
                message: message
            )
            appendLocked(.retry(key, retry))
            return retry
        }
    }

    /// Makes every waiting retry due now, keeping its attempt count.
    func makeRetriesDue(now: Date) {
        lock.withLock {
            for (key, retry) in state.retries where retry.notBefore > now {
                appendLocked(.retry(key, Retry(
                    attempts: retry.attempts,
                    failedAt: retry.failedAt,
                    notBefore: now,
                    message: retry.message
                )))
            }
        }
    }

    func beginTransfer(_ transfer: Transfer) {
        append(.began(transfer))
    }

    /// Removes and returns the transfer whose task description is `tempName`, or nil when it is
    /// unknown (already ended, or a task from an earlier install).
    func endTransfer(_ tempName: String) -> Transfer? {
        lock.withLock {
            guard let transfer = state.transfers[tempName] else { return nil }
            appendLocked(.ended(tempName))
            return transfer
        }
    }

    private func append(_ event: Event) {
        lock.withLock { appendLocked(event) }
    }

    private func appendLocked(_ event: Event) {
        Self.apply(event, to: &state)
        guard var line = try? encoder.encode(event) else { return }
        line.append(UInt8(ascii: "\n"))
        do {
            let handle = try openHandle()
            try handle.seekToEnd()
            try handle.write(contentsOf: line)
        } catch {
            // The in-memory state stays authoritative; the next load re-plans from what was written.
            try? self.handle?.close()
            self.handle = nil
        }
    }

    private func openHandle() throws -> FileHandle {
        if let handle { return handle }
        let directory = fileURL.deletingLastPathComponent()
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        if !FileManager.default.fileExists(atPath: fileURL.path) {
            FileManager.default.createFile(atPath: fileURL.path, contents: nil)
        }
        let handle = try FileHandle(forWritingTo: fileURL)
        self.handle = handle
        return handle
    }

    /// Rewrites the journal as the minimal events reproducing the current state.
    private func compact() {
        var events: [Event] = []
        if let deviceId = state.deviceId { events.append(.device(deviceId)) }
        if state.reconciled { events.append(.reconciled) }
        events += state.records.map { .record($0.key, $0.value) }
        events += state.retries.map { .retry($0.key, $0.value) }
        events += state.transfers.values.map { .began($0) }
        var data = Data()
        for event in events {
            guard let line = try? encoder.encode(event) else { continue }
            data.append(line)
            data.append(UInt8(ascii: "\n"))
        }
        try? handle?.close()
        handle = nil
        try? FileManager.default.createDirectory(
            at: fileURL.deletingLastPathComponent(),
            withIntermediateDirectories: true
        )
        try? data.write(to: fileURL, options: .atomic)
    }

    private static func apply(_ event: Event, to state: inout Snapshot) {
        switch event {
        case let .device(id):
            state = Snapshot(deviceId: id)
        case .reconciled:
            state.reconciled = true
        case let .record(key, record):
            state.records[key] = record
            state.retries[key] = nil
        case let .retry(key, retry):
            state.retries[key] = retry
        case let .began(transfer):
            state.transfers[transfer.tempName] = transfer
        case let .ended(tempName):
            state.transfers[tempName] = nil
        }
    }
}

struct BackupSettings: Codable, Equatable, Sendable {
    static let defaultDeviceName = "iPhone"

    var enabled = false
    var includeVideos = true
    var allowCellular = false
    var deviceName = BackupSettings.defaultDeviceName

    /// Trimmed and at most 64 characters (the server's limit); empty falls back to "iPhone".
    static func normalizedDeviceName(_ raw: String) -> String {
        let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return defaultDeviceName }
        return String(trimmed.prefix(64)).trimmingCharacters(in: .whitespacesAndNewlines)
    }
}

final class BackupSettingsStore: @unchecked Sendable {
    static let key = "com.photobrain.backup.settings.v1"

    private let defaults: UserDefaults

    init(defaults: UserDefaults = .standard) {
        self.defaults = defaults
    }

    func load() -> BackupSettings {
        guard let data = defaults.data(forKey: Self.key),
              let settings = try? JSONDecoder().decode(BackupSettings.self, from: data) else {
            return BackupSettings()
        }
        return settings
    }

    func save(_ settings: BackupSettings) {
        guard let data = try? JSONEncoder().encode(settings) else { return }
        defaults.set(data, forKey: Self.key)
    }
}

protocol DeviceIDStorage {
    func read() -> String?
    func write(_ id: String)
}

enum BackupDeviceID {
    /// The persisted device UUID, generated and stored once. The Keychain copy survives
    /// reinstalls so `/uploads/known` reconciliation finds this device's earlier uploads; the
    /// defaults copy covers a Keychain failure.
    static func resolve(primary: DeviceIDStorage, fallback: DeviceIDStorage) -> String {
        let stored = primary.read() ?? fallback.read()
        let id = stored.flatMap { UUID(uuidString: $0) }?.uuidString.lowercased() ?? UUID().uuidString.lowercased()
        if primary.read() != id { primary.write(id) }
        if fallback.read() != id { fallback.write(id) }
        return id
    }
}

struct DefaultsDeviceIDStorage: DeviceIDStorage {
    static let key = "com.photobrain.backup.deviceId"
    let defaults: UserDefaults

    func read() -> String? { defaults.string(forKey: Self.key) }
    func write(_ id: String) { defaults.set(id, forKey: Self.key) }
}

struct KeychainDeviceIDStorage: DeviceIDStorage {
    var service = "com.photobrain.backup"
    var account = "deviceId"

    private var query: [String: Any] {
        [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
        ]
    }

    func read() -> String? {
        var query = query
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne
        var result: AnyObject?
        guard SecItemCopyMatching(query as CFDictionary, &result) == errSecSuccess,
              let data = result as? Data else { return nil }
        return String(data: data, encoding: .utf8)
    }

    func write(_ id: String) {
        let data = Data(id.utf8)
        let status = SecItemUpdate(query as CFDictionary, [kSecValueData as String: data] as CFDictionary)
        guard status == errSecItemNotFound else { return }
        var item = query
        item[kSecValueData as String] = data
        item[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        SecItemAdd(item as CFDictionary, nil)
    }
}
