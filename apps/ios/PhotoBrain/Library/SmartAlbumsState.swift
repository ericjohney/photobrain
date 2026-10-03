import Foundation

/// Owns the smart album list and its mutations. Create applies once the server confirms it;
/// rename and delete apply optimistically and roll back (surfacing `errorMessage`) on failure.
@MainActor
final class SmartAlbumsStore: ObservableObject {
    enum LoadState: Equatable {
        case idle
        case loading
        case loaded
        case failed(String)
    }

    @Published private(set) var albums: [SmartAlbumDTO] = []
    @Published private(set) var loadState: LoadState = .idle
    @Published private(set) var errorMessage: String?

    let api: any PhotoBrainAPI
    private var loadTask: Task<Void, Never>?
    /// Bumped by every load and every mutation; older list responses are discarded.
    private var generation = 0

    init(api: any PhotoBrainAPI) {
        self.api = api
    }

    func album(id: Int) -> SmartAlbumDTO? {
        albums.first { $0.id == id }
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
                let response = try await api.smartAlbums()
                guard !Task.isCancelled, requestGeneration == generation else { return }
                albums = response.albums
                loadState = .loaded
            } catch is CancellationError {
                return
            } catch {
                guard requestGeneration == generation else { return }
                let message = CollectionsStore.message(for: error)
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

    /// Saves `filters` and an optional semantic `query` as a new album. Throws validation
    /// errors without sending a request, and server errors (e.g. a taken name) for the caller
    /// to present; the list changes only on success.
    func create(name: String, filters: SmartAlbumFilters, query: String?) async throws -> SmartAlbumDTO {
        let draft = try SmartAlbumDraft.validated(name: name, filters: filters, query: query)
        let created = try await api.createSmartAlbum(name: draft.name, filters: draft.filters, query: draft.query)
        supersedeLoad()
        upsert(created)
        return created
    }

    /// Shows the new name immediately; restores the previous album if the server rejects it.
    @discardableResult
    func rename(id: Int, to name: String) async -> Bool {
        errorMessage = nil
        let validName: String
        do {
            validName = try SmartAlbumDraft.validatedName(name)
        } catch {
            errorMessage = CollectionsStore.message(for: error)
            return false
        }
        guard let previous = album(id: id) else { return false }
        supersedeLoad()
        var renamed = previous
        renamed.name = validName
        upsert(renamed)
        do {
            let confirmed = try await api.renameSmartAlbum(id: id, name: validName)
            supersedeLoad()
            if album(id: id) != nil { upsert(confirmed) }
            return true
        } catch {
            supersedeLoad()
            if album(id: id) != nil { upsert(previous) }
            handleMutationFailure(error)
            return false
        }
    }

    /// Removes the album immediately; reinserts it if the server rejects the delete. The
    /// album's photos are never touched.
    @discardableResult
    func delete(id: Int) async -> Bool {
        errorMessage = nil
        guard let previous = album(id: id) else { return false }
        supersedeLoad()
        albums.removeAll { $0.id == id }
        do {
            try await api.deleteSmartAlbum(id: id)
            supersedeLoad()
            return true
        } catch {
            supersedeLoad()
            if !isNotFound(error) { upsert(previous) }
            handleMutationFailure(error)
            return false
        }
    }

    private func isNotFound(_ error: Error) -> Bool {
        (error as? PhotoBrainAPIError)?.code == "SMART_ALBUM_NOT_FOUND"
    }

    private func handleMutationFailure(_ error: Error) {
        // A cancelled request has an unknown outcome; roll back silently.
        guard !(error is CancellationError) else { return }
        errorMessage = CollectionsStore.message(for: error)
        if isNotFound(error) { refreshInBackground() }
    }

    private func refreshInBackground() {
        Task { [weak self] in await self?.load() }
    }

    /// A local mutation is newer than any list response still in flight. If the list was
    /// never loaded, fetch it now so the mutated entry is not the only one shown.
    private func supersedeLoad() {
        generation += 1
        loadTask?.cancel()
        loadTask = nil
        if loadState != .loaded { refreshInBackground() }
    }

    /// Inserts or replaces an album, keeping the server's case-insensitive name order.
    private func upsert(_ album: SmartAlbumDTO) {
        albums.removeAll { $0.id == album.id }
        let index = albums.firstIndex {
            $0.name.caseInsensitiveCompare(album.name) == .orderedDescending
        } ?? albums.endIndex
        albums.insert(album, at: index)
    }
}
