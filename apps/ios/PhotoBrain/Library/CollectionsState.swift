import Foundation

/// A store showing photos whose visibility depends on collection membership.
@MainActor
protocol CollectionMembershipObserving: AnyObject {
    func collectionMembershipChanged(collectionId: Int, photoIds: [Int], isMember: Bool)
}

/// Owns the collection list and every collection mutation. Create/rename/delete apply only after
/// the server confirms them, so a failure leaves the list unchanged and surfaces `errorMessage`.
@MainActor
final class CollectionsStore: ObservableObject {
    enum LoadState: Equatable {
        case idle
        case loading
        case loaded
        case failed(String)
    }

    @Published private(set) var collections: [CollectionDTO] = []
    @Published private(set) var loadState: LoadState = .idle
    @Published private(set) var errorMessage: String?

    let api: any PhotoBrainAPI
    private var loadTask: Task<Void, Never>?
    /// Bumped by every load and confirmed mutation; older list responses are discarded.
    private var generation = 0
    private var observers: [WeakObserver] = []

    private struct WeakObserver {
        weak var observer: (any CollectionMembershipObserving)?
    }

    init(api: any PhotoBrainAPI) {
        self.api = api
    }

    func collection(id: Int) -> CollectionDTO? {
        collections.first { $0.id == id }
    }

    func register(_ observer: any CollectionMembershipObserving) {
        observers.removeAll { $0.observer == nil || $0.observer === observer }
        observers.append(WeakObserver(observer: observer))
    }

    func dismissError() {
        errorMessage = nil
    }

    /// Refreshes the list. A failure before any successful load becomes `.failed`; later
    /// failures keep the current list and surface `errorMessage`.
    func load() async {
        generation += 1
        let requestGeneration = generation
        loadTask?.cancel()
        if loadState != .loaded { loadState = .loading }
        let task = Task { [api] in
            do {
                let response = try await api.collections()
                guard !Task.isCancelled, requestGeneration == generation else { return }
                collections = response.collections
                loadState = .loaded
            } catch is CancellationError {
                return
            } catch {
                guard requestGeneration == generation else { return }
                let message = Self.message(for: error)
                if loadState == .loaded {
                    errorMessage = message
                } else {
                    loadState = .failed(message)
                }
            }
        }
        loadTask = task
        await task.value
    }

    func loadIfNeeded() async {
        switch loadState {
        case .idle, .failed: await load()
        case .loading: await loadTask?.value
        case .loaded: return
        }
    }

    /// Creates a collection, optionally seeded with photos. Returns `nil` and sets
    /// `errorMessage` when the name is invalid (no request is sent) or the server rejects it.
    @discardableResult
    func create(name: String, photoIds: [Int] = []) async -> CollectionDTO? {
        errorMessage = nil
        do {
            return try await createCollection(name: name, photoIds: photoIds)
        } catch is CancellationError {
            return nil
        } catch {
            errorMessage = Self.message(for: error)
            return nil
        }
    }

    /// Throwing variant for callers that present errors in their own context (sheets).
    func createCollection(name: String, photoIds: [Int] = []) async throws -> CollectionDTO {
        let validName = try CollectionName.validated(name)
        let seed = Array(photoIds.prefix(CollectionName.maximumPhotoBatch))
        let created = try await api.createCollection(name: validName, photoIds: seed.isEmpty ? nil : seed)
        supersedeLoad()
        upsert(created)
        if !seed.isEmpty {
            notify(collectionId: created.id, photoIds: seed, isMember: true)
        }
        let remainder = Array(photoIds.dropFirst(seed.count))
        if !remainder.isEmpty {
            try await setMembership(remainder, collectionId: created.id, isMember: true)
        }
        return collection(id: created.id) ?? created
    }

    @discardableResult
    func rename(id: Int, to name: String) async -> Bool {
        errorMessage = nil
        do {
            let validName = try CollectionName.validated(name)
            let renamed = try await api.renameCollection(id: id, name: validName)
            supersedeLoad()
            upsert(renamed)
            return true
        } catch is CancellationError {
            return false
        } catch {
            handleMutationFailure(error)
            return false
        }
    }

    /// Deletes the collection only; its photos are untouched.
    @discardableResult
    func delete(id: Int) async -> Bool {
        errorMessage = nil
        do {
            try await api.deleteCollection(id: id)
            supersedeLoad()
            collections.removeAll { $0.id == id }
            return true
        } catch is CancellationError {
            return false
        } catch {
            handleMutationFailure(error)
            return false
        }
    }

    /// Adds or removes photos in server-sized batches (one request for up to 500 photos).
    /// Each confirmed batch updates the count and notifies observers; afterwards the list is
    /// refreshed in the background so covers reflect the most recently added photo.
    func setMembership(_ photoIds: [Int], collectionId: Int, isMember: Bool) async throws {
        guard !photoIds.isEmpty else { return }
        var start = photoIds.startIndex
        defer { refreshInBackground() }
        while start < photoIds.endIndex {
            let end = min(start + CollectionName.maximumPhotoBatch, photoIds.endIndex)
            let batch = Array(photoIds[start..<end])
            let photoCount = isMember
                ? try await api.addPhotos(toCollection: collectionId, photoIds: batch).photoCount
                : try await api.removePhotos(fromCollection: collectionId, photoIds: batch).photoCount
            if let index = collections.firstIndex(where: { $0.id == collectionId }) {
                collections[index].photoCount = photoCount
            }
            notify(collectionId: collectionId, photoIds: batch, isMember: isMember)
            start = end
        }
    }

    static func message(for error: Error) -> String {
        (error as? LocalizedError)?.errorDescription ?? error.localizedDescription
    }

    private func handleMutationFailure(_ error: Error) {
        errorMessage = Self.message(for: error)
        if (error as? PhotoBrainAPIError)?.code == "COLLECTION_NOT_FOUND" {
            refreshInBackground()
        }
    }

    private func refreshInBackground() {
        Task { [weak self] in await self?.load() }
    }

    /// A confirmed mutation is newer than any list response still in flight. If the list was
    /// never loaded, fetch it now so the confirmed entry is not the only one shown.
    private func supersedeLoad() {
        generation += 1
        loadTask?.cancel()
        loadTask = nil
        if loadState != .loaded { refreshInBackground() }
    }

    /// Inserts or replaces a collection, keeping the server's case-insensitive name order.
    private func upsert(_ collection: CollectionDTO) {
        collections.removeAll { $0.id == collection.id }
        let index = collections.firstIndex {
            $0.name.caseInsensitiveCompare(collection.name) == .orderedDescending
        } ?? collections.endIndex
        collections.insert(collection, at: index)
    }

    private func notify(collectionId: Int, photoIds: [Int], isMember: Bool) {
        observers.removeAll { $0.observer == nil }
        for entry in observers {
            entry.observer?.collectionMembershipChanged(
                collectionId: collectionId,
                photoIds: photoIds,
                isMember: isMember
            )
        }
    }
}

/// Backs the loupe's Add to Collection sheet for one photo. Toggles apply optimistically and
/// roll back when the server rejects them.
@MainActor
final class CollectionMembershipStore: ObservableObject {
    enum State: Equatable {
        case loading
        case loaded
        case failed(String)
    }

    let photoID: Int
    let collections: CollectionsStore
    @Published private(set) var state: State = .loading
    @Published private(set) var memberIDs: Set<Int> = []
    /// Collections with an add/remove in flight; their rows are disabled until it settles.
    @Published private(set) var inFlightIDs: Set<Int> = []
    @Published private(set) var errorMessage: String?

    init(photoID: Int, collections: CollectionsStore) {
        self.photoID = photoID
        self.collections = collections
    }

    func isMember(_ collectionId: Int) -> Bool {
        memberIDs.contains(collectionId)
    }

    func load() async {
        if state != .loaded { state = .loading }
        async let list: Void = collections.loadIfNeeded()
        do {
            let response = try await collections.api.collectionsForPhoto(id: photoID)
            memberIDs = Set(response.collectionIds)
            state = .loaded
        } catch is CancellationError {
            await list
            return
        } catch {
            state = .failed(CollectionsStore.message(for: error))
        }
        await list
    }

    func dismissError() {
        errorMessage = nil
    }

    @discardableResult
    func toggle(_ collectionId: Int) -> Task<Void, Never>? {
        guard state == .loaded, !inFlightIDs.contains(collectionId) else { return nil }
        errorMessage = nil
        let wasMember = memberIDs.contains(collectionId)
        setMember(collectionId, !wasMember)
        inFlightIDs.insert(collectionId)
        return Task { [photoID, collections] in
            defer { inFlightIDs.remove(collectionId) }
            do {
                try await collections.setMembership([photoID], collectionId: collectionId, isMember: !wasMember)
            } catch is CancellationError {
                setMember(collectionId, wasMember)
            } catch {
                setMember(collectionId, wasMember)
                errorMessage = CollectionsStore.message(for: error)
            }
        }
    }

    /// Creates a collection containing this photo.
    @discardableResult
    func createCollection(named name: String) async -> Bool {
        errorMessage = nil
        do {
            let created = try await collections.createCollection(name: name, photoIds: [photoID])
            memberIDs.insert(created.id)
            return true
        } catch is CancellationError {
            return false
        } catch {
            errorMessage = CollectionsStore.message(for: error)
            return false
        }
    }

    private func setMember(_ collectionId: Int, _ member: Bool) {
        if member {
            memberIDs.insert(collectionId)
        } else {
            memberIDs.remove(collectionId)
        }
    }
}
