import Foundation
import SwiftUI

enum ActiveSnapshotTrigger: String, Sendable {
    case restore
    case foreground
    case successfulSubmission
    case lostSubmissionResponse
    case manualLibraryRefresh
    case selectedTerminal
    case selectedUnknown
    case selectedBecameStalled
    case manualRecovery
}

enum ScanPollingPolicy {
    static let progressingInterval: Duration = .milliseconds(1_500)
    static let stalledInterval: Duration = .seconds(15)
    static let stalledAge: TimeInterval = 5 * 60

    static func isStalled(_ scan: ScanDTO, now: Date = Date()) -> Bool {
        scan.phase == .queued
            && scan.status == .queued
            && now.timeIntervalSince(scan.updatedAt) >= stalledAge
    }

    static func interval(for scan: ScanDTO?, lastRequestFailed: Bool, now: Date = Date()) -> Duration {
        guard !lastRequestFailed, let scan, !isStalled(scan, now: now) else {
            return stalledInterval
        }
        return progressingInterval
    }
}

@MainActor
final class ScanCoordinator: ObservableObject {
    enum MutationState: Equatable {
        case idle
        case checking
        case submitting
        case lostResponse
    }

    @Published private(set) var selectedScan: ScanDTO?
    @Published private(set) var isRestoring = true
    @Published private(set) var mutationState: MutationState = .idle
    @Published private(set) var statusMessage: String?
    @Published private(set) var recoveryError: String?
    @Published private(set) var requiresDuplicateRiskConfirmation = false
    @Published private(set) var pendingForce = false

    private let api: any PhotoBrainAPI
    private let migration: MigrationStore
    private var selectedID: String?
    private var selectedClassifiedStalled = false
    private var pollingTask: Task<Void, Never>?
    private var statusTask: Task<ScanDTO?, Error>?
    private var statusGeneration = 0
    private var snapshotTask: Task<Void, Never>?
    private var snapshotGeneration = 0
    private var hasUnresolvedLostSubmission = false
    private var invalidatedTerminalIDs: Set<String> = []
    private var lastInvalidatedProgress: (id: String, phase: ScanPhase, current: Int)?
    private var lastLibraryInvalidation = Date.distantPast
    private var trailingInvalidationTask: Task<Void, Never>?
    var invalidateLibrary: (@MainActor () async -> Void)?
    var invalidateSearch: (@MainActor () async -> Void)?

    init(api: any PhotoBrainAPI, migration: MigrationStore) {
        self.api = api
        self.migration = migration
    }

    var isActive: Bool {
        selectedID != nil && selectedScan?.isTerminal != true
    }

    var isProgressing: Bool {
        isActive && !isStalled
    }

    var controlsDisabled: Bool {
        isRestoring || mutationState != .idle || isProgressing
    }

    var isStalled: Bool {
        selectedScan.map { ScanPollingPolicy.isStalled($0) } ?? false
    }

    var duplicateRiskMessage: String {
        if isStalled {
            return "The older queued request is unconfirmed and may still start later. Starting another scan can duplicate work."
        }
        return "PhotoBrain could not confirm whether the previous request reached the server. Starting again could create a duplicate scan."
    }

    var activityTitle: String {
        guard let scan = selectedScan else {
            return recoveryError == nil ? "Checking scan status" : "Scan status unavailable"
        }
        if isStalled { return "Scan start unconfirmed" }
        switch scan.phase {
        case .queued: return "Waiting to scan"
        case .discovering: return "Finding photos"
        case .processing: return "Preparing photos"
        case .scanComplete: return "Preparing search indexing"
        case .embedding: return "Indexing for search"
        case .completed: return "Library scan complete"
        case .failed: return "Library scan failed"
        }
    }

    var activityDetail: String {
        if let recoveryError {
            return "\(recoveryError) PhotoBrain will retry the saved job status."
        }
        guard let scan = selectedScan else { return "Checking the saved scan with the server." }
        if isStalled {
            return "The queued request has not changed for five minutes. It may still start later; checks continue every 15 seconds."
        }
        if scan.total > 0 { return "\(scan.current.formatted()) of \(scan.total.formatted())" }
        switch scan.phase {
        case .scanComplete: return "Photos are ready; search indexing is starting."
        case .failed: return scan.error ?? "The scan could not be completed."
        default: return "Progress will appear when the server reports it."
        }
    }

    func restore(importedActiveID: String?) async {
        isRestoring = true
        if let importedActiveID {
            selectedID = importedActiveID
            await pollOnce(reconcileResolvedSelection: false)
        }
        await refreshActiveSnapshot(trigger: .restore)
        isRestoring = false
        startPollingIfNeeded()
    }

    func refreshActiveSnapshot(trigger: ActiveSnapshotTrigger) async {
        snapshotGeneration &+= 1
        let requestGeneration = snapshotGeneration
        let preferredID = selectedID
        let previousTask = snapshotTask
        previousTask?.cancel()
        if let previousTask {
            await previousTask.value
        }
        guard !Task.isCancelled,
              requestGeneration == snapshotGeneration else { return }
        let task = Task { [api] in
            do {
                let response = try await api.activeScans()
                guard !Task.isCancelled,
                      requestGeneration == snapshotGeneration else { return }
                let chosen = Self.selectJob(
                    from: response.jobs,
                    persistedID: preferredID,
                    currentID: selectedID
                )
                recoveryError = nil
                if let chosen {
                    await select(chosen, resetStallClassification: true)
                    startPollingIfNeeded()
                } else {
                    await clearSelection()
                }
            } catch is CancellationError {
                return
            } catch {
                guard !Task.isCancelled,
                      requestGeneration == snapshotGeneration else { return }
                recoveryError = (error as? LocalizedError)?.errorDescription ?? error.localizedDescription
            }
        }
        snapshotTask = task
        await task.value
    }

    func requestStart(force: Bool, acceptDuplicateRisk: Bool = false) async {
        statusMessage = nil
        let hadRecoveryUncertainty = recoveryError != nil
        recoveryError = nil
        requiresDuplicateRiskConfirmation = false
        pendingForce = force
        mutationState = .checking

        if isProgressing {
            statusMessage = "A library scan is already active."
            pendingForce = false
            mutationState = .idle
            return
        }
        if (hasUnresolvedLostSubmission || isStalled || hadRecoveryUncertainty),
           !acceptDuplicateRisk {
            requiresDuplicateRiskConfirmation = true
            mutationState = .idle
            return
        }

        if acceptDuplicateRisk {
            hasUnresolvedLostSubmission = false
        }
        let previousSelectedID = selectedID
        pendingForce = false
        mutationState = .submitting
        do {
            let response = try await api.startScan(force: force)
            guard response.success else {
                mutationState = .idle
                statusMessage = response.error ?? "The scan could not be started."
                return
            }
            guard let jobID = response.jobId, UUID(uuidString: jobID) != nil else {
                hasUnresolvedLostSubmission = true
                pendingForce = force
                mutationState = .lostResponse
                await refreshActiveSnapshot(trigger: .lostSubmissionResponse)
                statusMessage = "The server response did not identify the new scan. Starting again could create duplicate work."
                requiresDuplicateRiskConfirmation = !isProgressing
                mutationState = .idle
                return
            }
            let now = Date()
            let placeholder = ScanDTO(
                id: jobID.lowercased(),
                phase: .queued,
                current: 0,
                total: 0,
                status: .queued,
                error: nil,
                createdAt: now,
                updatedAt: now
            )
            await select(placeholder, resetStallClassification: true)
            await refreshActiveSnapshot(trigger: .successfulSubmission)
            mutationState = .idle
            startPollingIfNeeded()
        } catch let error as PhotoBrainAPIError where error.isDefinitiveScanRejection {
            mutationState = .idle
            statusMessage = error.errorDescription
        } catch {
            hasUnresolvedLostSubmission = true
            pendingForce = force
            mutationState = .lostResponse
            await refreshActiveSnapshot(trigger: .lostSubmissionResponse)
            if isProgressing, selectedID != previousSelectedID {
                statusMessage = "An active scan was found after the response was lost. Starting again later could still create duplicate work."
            } else {
                statusMessage = "The scan response was lost. Starting again could create a duplicate scan."
            }
            requiresDuplicateRiskConfirmation = !isProgressing
            mutationState = .idle
        }
    }

    func confirmDuplicateRisk() -> Bool? {
        guard requiresDuplicateRiskConfirmation else { return nil }
        let force = pendingForce
        requiresDuplicateRiskConfirmation = false
        pendingForce = false
        return force
    }

    func dismissDuplicateRiskPrompt() {
        requiresDuplicateRiskConfirmation = false
    }

    func cancelDuplicateRisk() {
        dismissDuplicateRiskPrompt()
        pendingForce = false
    }

    func applicationBecameActive() async {
        await pollOnce(reconcileResolvedSelection: false)
        await refreshActiveSnapshot(trigger: .foreground)
        startPollingIfNeeded()
    }

    func manualLibraryRefresh() async {
        await refreshActiveSnapshot(trigger: .manualLibraryRefresh)
        await pollOnce()
        startPollingIfNeeded()
    }

    func retryRecovery() async {
        await refreshActiveSnapshot(trigger: .manualRecovery)
        await pollOnce()
        startPollingIfNeeded()
    }

    static func selectJob(
        from jobs: [ScanDTO],
        persistedID: String?,
        currentID: String?,
        now: Date = Date()
    ) -> ScanDTO? {
        let active = jobs.filter { !$0.isTerminal }
        let preferredID = currentID ?? persistedID
        if let preferredID,
           let preferred = active.first(where: { $0.id == preferredID }),
           !ScanPollingPolicy.isStalled(preferred, now: now) {
            return preferred
        }
        if let progressing = active.first(where: { !ScanPollingPolicy.isStalled($0, now: now) }) {
            return progressing
        }
        if let preferredID,
           let preferredStalled = active.first(where: { $0.id == preferredID }) {
            return preferredStalled
        }
        return active.first
    }

    private func startPollingIfNeeded() {
        pollingTask?.cancel()
        guard selectedID != nil, selectedScan?.isTerminal != true else { return }
        pollingTask = Task { [weak self] in
            while !Task.isCancelled {
                guard let self else { return }
                let interval = ScanPollingPolicy.interval(
                    for: self.selectedScan,
                    lastRequestFailed: self.recoveryError != nil
                )
                try? await Task.sleep(for: interval)
                guard !Task.isCancelled else { return }
                await self.pollOnce()
                if self.selectedID == nil || self.selectedScan?.isTerminal == true { return }
            }
        }
    }

    private func pollOnce(reconcileResolvedSelection: Bool = true) async {
        guard let id = selectedID else { return }
        statusGeneration &+= 1
        let requestGeneration = statusGeneration
        let previousTask = statusTask
        previousTask?.cancel()
        if let previousTask {
            _ = try? await previousTask.value
        }
        guard !Task.isCancelled,
              requestGeneration == statusGeneration,
              selectedID == id else { return }
        let task = Task { [api] in
            try await api.scan(id: id)
        }
        statusTask = task
        do {
            let response = try await task.value
            guard !Task.isCancelled,
                  requestGeneration == statusGeneration,
                  selectedID == id else { return }
            guard let scan = response else {
                await clearSelection(cancelPolling: false)
                guard selectedID == nil else { return }
                if reconcileResolvedSelection {
                    await refreshActiveSnapshot(trigger: .selectedUnknown)
                }
                return
            }

            recoveryError = nil
            let wasStalled = selectedClassifiedStalled
            await select(scan, resetStallClassification: false)
            guard requestGeneration == statusGeneration,
                  selectedID == id else { return }
            observeForInvalidation(scan)
            let nowStalled = ScanPollingPolicy.isStalled(scan)
            selectedClassifiedStalled = nowStalled

            if scan.isTerminal {
                await handleTerminal(
                    scan,
                    requestGeneration: requestGeneration,
                    reconcileSelection: reconcileResolvedSelection
                )
            } else if nowStalled, !wasStalled {
                if reconcileResolvedSelection {
                    await refreshActiveSnapshot(trigger: .selectedBecameStalled)
                }
                startPollingIfNeeded()
            }
        } catch is CancellationError {
            return
        } catch {
            guard !Task.isCancelled,
                  requestGeneration == statusGeneration,
                  selectedID == id else { return }
            recoveryError = (error as? LocalizedError)?.errorDescription ?? error.localizedDescription
        }
    }

    private func handleTerminal(
        _ scan: ScanDTO,
        requestGeneration: Int,
        reconcileSelection: Bool
    ) async {
        trailingInvalidationTask?.cancel()
        trailingInvalidationTask = nil
        if invalidatedTerminalIDs.insert(scan.id).inserted {
            lastLibraryInvalidation = Date()
            await invalidateLibrary?()
            await invalidateSearch?()
        }
        guard requestGeneration == statusGeneration,
              selectedID == scan.id else { return }
        if reconcileSelection {
            await refreshActiveSnapshot(trigger: .selectedTerminal)
        }
    }

    private func select(_ scan: ScanDTO, resetStallClassification: Bool) async {
        if resetStallClassification || selectedID != scan.id {
            invalidateStatusRequest()
        }
        selectedID = scan.id
        selectedScan = scan
        if resetStallClassification {
            selectedClassifiedStalled = ScanPollingPolicy.isStalled(scan)
        }
        if scan.isTerminal {
            await migration.setActiveScanID(nil)
        } else {
            await migration.setActiveScanID(scan.id)
        }
    }

    private func clearSelection(cancelPolling: Bool = true) async {
        if cancelPolling {
            pollingTask?.cancel()
        }
        invalidateStatusRequest()
        selectedID = nil
        selectedScan = nil
        selectedClassifiedStalled = false
        await migration.setActiveScanID(nil)
    }

    private func invalidateStatusRequest() {
        statusGeneration &+= 1
        statusTask?.cancel()
    }

    private func observeForInvalidation(_ scan: ScanDTO) {
        guard !scan.isTerminal else { return }
        let previous = lastInvalidatedProgress
        let isProcessingAdvance = scan.phase == .processing
            && scan.current > (previous?.id == scan.id && previous?.phase == .processing ? previous?.current ?? 0 : 0)
        let enteredHandoff = scan.phase == .scanComplete
            && (previous?.id != scan.id || previous?.phase != .scanComplete)
        let enteredEmbedding = scan.phase == .embedding
            && (previous?.id != scan.id || previous?.phase != .embedding)
        guard isProcessingAdvance || enteredHandoff || enteredEmbedding else { return }
        lastInvalidatedProgress = (scan.id, scan.phase, scan.current)
        if enteredHandoff || enteredEmbedding || Date().timeIntervalSince(lastLibraryInvalidation) >= 1 {
            trailingInvalidationTask?.cancel()
            trailingInvalidationTask = nil
            lastLibraryInvalidation = Date()
            Task { await invalidateLibrary?() }
        } else {
            trailingInvalidationTask?.cancel()
            let remaining = max(0, 1 - Date().timeIntervalSince(lastLibraryInvalidation))
            trailingInvalidationTask = Task { [weak self] in
                try? await Task.sleep(for: .milliseconds(Int(remaining * 1_000)))
                guard !Task.isCancelled, let self else { return }
                self.lastLibraryInvalidation = Date()
                await self.invalidateLibrary?()
                self.trailingInvalidationTask = nil
            }
        }
    }
}
