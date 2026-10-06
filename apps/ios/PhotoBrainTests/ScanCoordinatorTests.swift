import XCTest
@testable import PhotoBrain

@MainActor
final class ScanCoordinatorTests: XCTestCase {
    func testSelectionPreservesProgressingButPrefersProgressingOverPersistedStall() {
        let now = Date()
        let stalled = TestModels.scan(
            id: "00000000-0000-0000-0000-000000000001",
            phase: .queued,
            status: .queued,
            current: 0,
            updatedAt: now.addingTimeInterval(-300)
        )
        let progressing = TestModels.scan(
            id: "00000000-0000-0000-0000-000000000002",
            phase: .processing,
            status: .running,
            updatedAt: now
        )
        let otherProgressing = TestModels.scan(
            id: "00000000-0000-0000-0000-000000000003",
            phase: .embedding,
            status: .running,
            updatedAt: now
        )

        XCTAssertEqual(
            ScanCoordinator.selectJob(
                from: [stalled, progressing, otherProgressing],
                persistedID: stalled.id,
                currentID: stalled.id,
                now: now
            )?.id,
            progressing.id
        )
        XCTAssertEqual(
            ScanCoordinator.selectJob(
                from: [otherProgressing, progressing],
                persistedID: nil,
                currentID: progressing.id,
                now: now
            )?.id,
            progressing.id
        )
    }

    func testOnlyUnchangedQueuedRowsBecomeStalled() {
        let now = Date()
        let recentQueued = TestModels.scan(
            id: "00000000-0000-0000-0000-000000000001",
            phase: .queued,
            status: .queued,
            current: 0,
            updatedAt: now.addingTimeInterval(-299)
        )
        let stalledQueued = TestModels.scan(
            id: "00000000-0000-0000-0000-000000000002",
            phase: .queued,
            status: .queued,
            current: 0,
            updatedAt: now.addingTimeInterval(-300)
        )
        let oldProcessing = TestModels.scan(
            id: "00000000-0000-0000-0000-000000000003",
            phase: .processing,
            status: .running,
            updatedAt: now.addingTimeInterval(-900)
        )

        XCTAssertFalse(ScanPollingPolicy.isStalled(recentQueued, now: now))
        XCTAssertTrue(ScanPollingPolicy.isStalled(stalledQueued, now: now))
        XCTAssertFalse(ScanPollingPolicy.isStalled(oldProcessing, now: now))
        XCTAssertEqual(
            ScanPollingPolicy.interval(for: recentQueued, lastRequestFailed: false, now: now),
            .milliseconds(1_500)
        )
        XCTAssertEqual(
            ScanPollingPolicy.interval(for: stalledQueued, lastRequestFailed: false, now: now),
            .seconds(15)
        )
    }

    func testDomainFailureIsDisplayedWithoutSelectingOrPersistingJob() async throws {
        let api = TestAPI()
        await api.setStartResponse(
            StartScanResponseDTO(
                success: false,
                jobId: "00000000-0000-0000-0000-000000000004",
                error: "The scan could not be started"
            )
        )
        let suite = "ScanCoordinatorTests.\(UUID().uuidString)"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }
        let preferences = PreferencesStore(defaults: defaults)
        let coordinator = ScanCoordinator(api: api, preferences: preferences)

        await coordinator.requestStart(force: false)

        XCTAssertNil(coordinator.selectedScan)
        XCTAssertFalse(coordinator.isActive)
        XCTAssertEqual(coordinator.statusMessage, "The scan could not be started")
        let savedID = await preferences.activeScanID
        XCTAssertNil(savedID)
    }

    func testBackgroundTerminalPollReconcilesActiveSnapshotBeforeLoopStops() async throws {
        let api = TestAPI()
        let id = "00000000-0000-0000-0000-000000000010"
        let running = TestModels.scan(id: id, updatedAt: Date())
        await api.setActive([running])
        let suite = "ScanCoordinatorTerminalTests.\(UUID().uuidString)"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }
        let coordinator = ScanCoordinator(
            api: api,
            preferences: PreferencesStore(defaults: defaults)
        )
        await coordinator.restore(savedActiveID: nil)
        let initialSnapshotCount = await api.recordedActiveCallCount()
        XCTAssertEqual(initialSnapshotCount, 1)

        let terminal = TestModels.scan(
            id: id,
            phase: .completed,
            current: 10,
            updatedAt: Date()
        )
        await api.setScan(id: id, response: terminal)
        await api.setActive([])
        try await Task.sleep(for: .milliseconds(1_700))

        let reconciledSnapshotCount = await api.recordedActiveCallCount()
        XCTAssertGreaterThanOrEqual(reconciledSnapshotCount, 2)
        XCTAssertNil(coordinator.selectedScan)
    }

    func testTerminalJobsAreNeverSelectedAsActive() {
        let completed = TestModels.scan(
            id: "00000000-0000-0000-0000-000000000001",
            phase: .completed,
            current: 10,
            updatedAt: Date()
        )
        XCTAssertNil(ScanCoordinator.selectJob(from: [completed], persistedID: completed.id, currentID: nil))
    }
    func testLostSubmissionDismissalStillRequiresConfirmationAndConfirmedForceSubmitsOnce() async throws {
        let api = TestAPI()
        await api.setStartFailure(true)
        let suite = "ScanCoordinatorLostSubmissionTests.\(UUID().uuidString)"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }
        let coordinator = ScanCoordinator(
            api: api,
            preferences: PreferencesStore(defaults: defaults)
        )

        await coordinator.requestStart(force: false)
        XCTAssertTrue(coordinator.requiresDuplicateRiskConfirmation)
        var submittedForces = await api.recordedStartForces()
        XCTAssertEqual(submittedForces, [false])

        coordinator.cancelDuplicateRisk()
        await coordinator.requestStart(force: true)
        XCTAssertTrue(coordinator.requiresDuplicateRiskConfirmation)
        submittedForces = await api.recordedStartForces()
        XCTAssertEqual(submittedForces, [false])

        coordinator.dismissDuplicateRiskPrompt()
        await coordinator.requestStart(force: true)
        XCTAssertTrue(coordinator.requiresDuplicateRiskConfirmation)
        submittedForces = await api.recordedStartForces()
        XCTAssertEqual(submittedForces, [false])

        let confirmedForce = try XCTUnwrap(coordinator.confirmDuplicateRisk())
        XCTAssertTrue(confirmedForce)
        coordinator.dismissDuplicateRiskPrompt()
        await api.setStartFailure(false)
        await coordinator.requestStart(force: confirmedForce, acceptDuplicateRisk: true)

        submittedForces = await api.recordedStartForces()
        XCTAssertEqual(submittedForces, [false, true])
        XCTAssertFalse(coordinator.requiresDuplicateRiskConfirmation)
    }

    func testLostForceSubmissionConfirmationRetriesExactlyOnceWithForce() async throws {
        let api = TestAPI()
        await api.setStartFailure(true)
        let suite = "ScanCoordinatorLostForceTests.\(UUID().uuidString)"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }
        let coordinator = ScanCoordinator(
            api: api,
            preferences: PreferencesStore(defaults: defaults)
        )

        await coordinator.requestStart(force: true)
        XCTAssertTrue(coordinator.requiresDuplicateRiskConfirmation)
        let confirmedForce = try XCTUnwrap(coordinator.confirmDuplicateRisk())
        XCTAssertTrue(confirmedForce)

        coordinator.dismissDuplicateRiskPrompt()
        await api.setStartFailure(false)
        await coordinator.requestStart(force: confirmedForce, acceptDuplicateRisk: true)

        let submittedForces = await api.recordedStartForces()
        XCTAssertEqual(submittedForces, [true, true])
        XCTAssertFalse(coordinator.requiresDuplicateRiskConfirmation)
    }

    func testUnrelatedActiveJobDoesNotResolveLostSubmissionAmbiguity() async throws {
        let api = TestAPI()
        let unrelatedID = "00000000-0000-0000-0000-000000000012"
        await api.setActive([TestModels.scan(id: unrelatedID, updatedAt: Date())])
        await api.setStartFailure(true)
        let suite = "ScanCoordinatorUnrelatedJobTests.\(UUID().uuidString)"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }
        let coordinator = ScanCoordinator(
            api: api,
            preferences: PreferencesStore(defaults: defaults)
        )

        await coordinator.requestStart(force: false)
        XCTAssertTrue(coordinator.isProgressing)
        XCTAssertFalse(coordinator.requiresDuplicateRiskConfirmation)

        await api.setScan(
            id: unrelatedID,
            response: TestModels.scan(
                id: unrelatedID,
                phase: .completed,
                current: 10,
                updatedAt: Date()
            )
        )
        await api.setActive([])
        await coordinator.applicationBecameActive()
        await api.setStartFailure(false)
        await coordinator.requestStart(force: false)

        XCTAssertTrue(coordinator.requiresDuplicateRiskConfirmation)
        let submittedForces = await api.recordedStartForces()
        XCTAssertEqual(submittedForces, [false])
    }

    func testForegroundHandlesRetainedTerminalBeforeActiveDiscoveryClearsIt() async throws {
        let api = TestAPI()
        let id = "00000000-0000-0000-0000-000000000011"
        await api.setActive([TestModels.scan(id: id, updatedAt: Date())])
        let suite = "ScanCoordinatorForegroundTests.\(UUID().uuidString)"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }
        let coordinator = ScanCoordinator(
            api: api,
            preferences: PreferencesStore(defaults: defaults)
        )
        var libraryInvalidations = 0
        var searchInvalidations = 0
        coordinator.invalidateLibrary = { libraryInvalidations += 1 }
        coordinator.invalidateSearch = { searchInvalidations += 1 }
        await coordinator.restore(savedActiveID: nil)

        await api.setScan(
            id: id,
            response: TestModels.scan(
                id: id,
                phase: .completed,
                current: 10,
                updatedAt: Date()
            )
        )
        await api.setActive([])
        await coordinator.applicationBecameActive()

        XCTAssertNil(coordinator.selectedScan)
        XCTAssertEqual(libraryInvalidations, 1)
        XCTAssertEqual(searchInvalidations, 1)
        let savedID = await PreferencesStore(defaults: defaults).activeScanID
        XCTAssertNil(savedID)
    }

    func testExpectedImportSkipsTheRunningJobAndTracksTheNextOneToCompletion() async throws {
        let api = TestAPI()
        let runningID = "00000000-0000-0000-0000-000000000020"
        let importID = "00000000-0000-0000-0000-000000000021"
        let running = TestModels.scan(id: runningID, updatedAt: Date())
        await api.setActive([running])
        let suite = "ScanCoordinatorImportTests.\(UUID().uuidString)"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }
        let coordinator = ScanCoordinator(api: api, preferences: PreferencesStore(defaults: defaults))
        var libraryInvalidations = 0
        coordinator.invalidateLibrary = { libraryInvalidations += 1 }
        await coordinator.restore(savedActiveID: nil)

        // The upload landed while `running` was active; its scan may predate the file.
        coordinator.expectImport()
        XCTAssertTrue(coordinator.isImportPending)
        await api.setScan(id: runningID, response: TestModels.scan(id: runningID, phase: .completed, current: 10, updatedAt: Date()))
        await api.setActive([])
        try await waitUntil(timeout: .seconds(6)) { coordinator.selectedScan == nil }
        XCTAssertTrue(coordinator.isImportPending, "the earlier job finishing is not the import")

        await api.setActive([TestModels.scan(id: importID, phase: .queued, current: 0, updatedAt: Date())])
        try await waitUntil(timeout: .seconds(6)) { coordinator.selectedScan?.id == importID }
        XCTAssertFalse(coordinator.isImportPending)
        let before = libraryInvalidations

        await api.setScan(id: importID, response: TestModels.scan(id: importID, phase: .completed, current: 1, updatedAt: Date()))
        await api.setActive([])
        try await waitUntil(timeout: .seconds(6)) { libraryInvalidations > before && coordinator.selectedScan == nil }
    }

    @MainActor
    private func waitUntil(
        timeout: Duration,
        _ condition: @MainActor () async -> Bool
    ) async throws {
        let deadline = ContinuousClock.now.advanced(by: timeout)
        while ContinuousClock.now < deadline {
            if await condition() { return }
            try await Task.sleep(for: .milliseconds(50))
        }
        XCTFail("condition not met within \(timeout)")
    }

}
