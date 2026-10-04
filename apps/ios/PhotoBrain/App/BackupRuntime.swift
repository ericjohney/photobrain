import BackgroundTasks
import SwiftUI
import UIKit

/// Process-wide backup objects. Created at launch, before the system delivers background
/// `URLSession` events or `BGProcessingTask`s, so relaunch completions reach the ledger.
@MainActor
final class BackupRuntime {
    static let shared = BackupRuntime()

    static var processingTaskIdentifier: String {
        (Bundle.main.bundleIdentifier ?? "com.photobrain.app") + ".backup"
    }

    /// Nil when the app has no valid API configuration.
    let coordinator: BackupCoordinator?
    private let session: BackgroundUploadSession?
    private var registeredProcessingTask = false

    private init() {
        guard let environment = try? AppEnvironment() else {
            coordinator = nil
            session = nil
            return
        }
        let fileManager = FileManager.default
        let support = fileManager.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("Backup", isDirectory: true)
        let caches = fileManager.urls(for: .cachesDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("BackupUploads", isDirectory: true)
        let deviceId = BackupDeviceID.resolve(
            primary: KeychainDeviceIDStorage(),
            fallback: DefaultsDeviceIDStorage(defaults: .standard)
        )
        let ledger = BackupLedger(fileURL: support.appendingPathComponent("ledger.jsonl"), deviceId: deviceId)
        let events = BackupSessionEvents(
            processor: BackupCompletionProcessor(ledger: ledger, temporaryDirectory: caches)
        )
        let session = BackgroundUploadSession(
            identifier: (Bundle.main.bundleIdentifier ?? "com.photobrain.app") + ".backup-uploads",
            events: events
        )
        let coordinator = BackupCoordinator(
            api: APIClient(baseURL: environment.apiURL),
            library: PhotoKitBackupLibrary(),
            transport: session,
            events: events,
            settingsStore: BackupSettingsStore(),
            deviceId: deviceId,
            baseURL: environment.apiURL
        )
        self.session = session
        self.coordinator = coordinator
        coordinator.scheduleBackgroundRun = { [weak self] in self?.scheduleProcessingTask() }
    }

    /// Must run before launch finishes.
    func registerProcessingTask() {
        guard !registeredProcessingTask else { return }
        registeredProcessingTask = true
        BGTaskScheduler.shared.register(forTaskWithIdentifier: Self.processingTaskIdentifier, using: nil) { task in
            Task { @MainActor in
                BackupRuntime.shared.run(task)
            }
        }
    }

    func handleEventsForBackgroundURLSession(identifier: String, completionHandler: @escaping () -> Void) {
        guard let session, session.identifier == identifier else {
            completionHandler()
            return
        }
        session.addBackgroundEventsCompletionHandler(completionHandler)
    }

    func scheduleProcessingTask() {
        guard coordinator?.settings.enabled == true else { return }
        let request = BGProcessingTaskRequest(identifier: Self.processingTaskIdentifier)
        request.requiresNetworkConnectivity = true
        request.requiresExternalPower = false
        request.earliestBeginDate = Date(timeIntervalSinceNow: 15 * 60)
        try? BGTaskScheduler.shared.submit(request)
    }

    private func run(_ task: BGTask) {
        guard let coordinator, coordinator.settings.enabled else {
            task.setTaskCompleted(success: true)
            return
        }
        scheduleProcessingTask()
        task.expirationHandler = {
            Task { @MainActor in coordinator.suspend() }
        }
        Task { @MainActor in
            await coordinator.runUntilIdle()
            task.setTaskCompleted(success: !coordinator.serverDisabled)
        }
    }
}

final class PhotoBrainAppDelegate: NSObject, UIApplicationDelegate {
    func application(
        _ application: UIApplication,
        didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil
    ) -> Bool {
        BackupRuntime.shared.registerProcessingTask()
        return true
    }

    func application(
        _ application: UIApplication,
        handleEventsForBackgroundURLSession identifier: String,
        completionHandler: @escaping () -> Void
    ) {
        BackupRuntime.shared.handleEventsForBackgroundURLSession(
            identifier: identifier,
            completionHandler: completionHandler
        )
    }
}

private struct BackupCoordinatorKey: EnvironmentKey {
    static let defaultValue: BackupCoordinator? = nil
}

extension EnvironmentValues {
    /// The camera-roll backup, installed at the root so every Settings presentation shows it.
    var backupCoordinator: BackupCoordinator? {
        get { self[BackupCoordinatorKey.self] }
        set { self[BackupCoordinatorKey.self] = newValue }
    }
}
