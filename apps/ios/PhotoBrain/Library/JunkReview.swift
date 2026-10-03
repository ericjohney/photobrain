import Foundation

/// Backs the junk Review screen: one reason-filtered, cursor-paginated candidate list plus
/// server-wide counts, with optimistic reject/keep decisions.
///
/// Resolving removes photos and decrements counts immediately. A failed request puts the
/// unresolved photos back in their original order, restores their counts, and surfaces an
/// error. While decisions are in flight, server counts from page loads are not adopted (they
/// may predate the decision); counts are refreshed once every decision has settled.
@MainActor
final class ReviewStore: ObservableObject, CurationApplying {
    enum LoadState: Equatable {
        case idle
        case loading
        case loaded
        case failed(String)
    }

    static let pageSize = 200

    @Published private(set) var state: LoadState = .idle
    @Published private(set) var records: [PhotoRecord] = []
    @Published private(set) var counts: JunkCountsDTO = .zero
    @Published private(set) var reason: JunkReason?
    @Published private(set) var nextCursor: Int?
    @Published private(set) var isLoadingMore = false
    @Published private(set) var errorMessage: String?
    @Published private(set) var isSelecting = false
    @Published private(set) var selectedIDs: Set<Int> = []
    @Published var activePhotoID: Int?

    let api: any PhotoBrainAPI
    let curation: PhotoCurationCenter
    private var loadTask: Task<Void, Never>?
    private var pageTask: Task<Void, Never>?
    /// Bumped whenever the list is replaced; late responses for an older list are dropped.
    private var generation = 0
    /// Photos with a reject/keep request in flight; never re-added by page loads.
    private var pendingIDs: Set<Int> = []
    private var countsStale = false
    private var needsReload = false

    init(api: any PhotoBrainAPI, curation: PhotoCurationCenter? = nil) {
        self.api = api
        self.curation = curation ?? PhotoCurationCenter(api: api)
        self.curation.register(self)
    }

    /// "Nothing to review": the loaded list is exhausted with no further page.
    var isEmpty: Bool {
        state == .loaded && records.isEmpty && nextCursor == nil
    }

    var selectedCount: Int { selectedIDs.count }

    func applyCuration(id: Int, curation: PhotoCuration) {
        records.applyCuration(id: id, curation: curation)
    }

    func loadIfNeeded() {
        if case .idle = state { load() }
    }

    /// Replaces the list with the first page for the current reason. Pull-to-refresh keeps
    /// the current photos visible until the response arrives.
    @discardableResult
    func load(retainingContent: Bool = true) -> Task<Void, Never> {
        generation += 1
        let requestGeneration = generation
        loadTask?.cancel()
        pageTask?.cancel()
        isLoadingMore = false
        needsReload = false
        if records.isEmpty || !retainingContent {
            records = []
            state = .loading
        }
        let reason = reason
        let task = Task { [api] in
            do {
                let response = try await api.junkReview(reason: reason, limit: Self.pageSize, cursor: nil)
                guard !Task.isCancelled, requestGeneration == generation else { return }
                records = makeRecords(response.photos, excluding: pendingIDs)
                nextCursor = response.nextCursor
                adopt(response.counts)
                let ids = Set(records.map(\.id))
                selectedIDs.formIntersection(ids)
                if let activePhotoID, !ids.contains(activePhotoID) { self.activePhotoID = nil }
                errorMessage = nil
                state = .loaded
            } catch is CancellationError {
                return
            } catch {
                guard requestGeneration == generation else { return }
                let message = Self.message(for: error)
                if records.isEmpty {
                    state = .failed(message)
                } else {
                    errorMessage = message
                    state = .loaded
                }
            }
        }
        loadTask = task
        return task
    }

    /// Switches the reason filter (`nil` = All) and reloads from the first page.
    func setReason(_ reason: JunkReason?) {
        guard reason != self.reason else { return }
        self.reason = reason
        activePhotoID = nil
        endSelection()
        load(retainingContent: false)
    }

    /// Fetches the page after `nextCursor`, appending only photos not already listed.
    @discardableResult
    func loadMore() -> Task<Void, Never>? {
        guard state == .loaded, !isLoadingMore, let cursor = nextCursor else { return nil }
        isLoadingMore = true
        let requestGeneration = generation
        let reason = reason
        let task = Task { [api] in
            defer { if requestGeneration == generation { isLoadingMore = false } }
            do {
                let response = try await api.junkReview(reason: reason, limit: Self.pageSize, cursor: cursor)
                guard !Task.isCancelled, requestGeneration == generation else { return }
                records.append(contentsOf: makeRecords(
                    response.photos,
                    excluding: pendingIDs.union(records.map(\.id))
                ))
                nextCursor = response.nextCursor
                adopt(response.counts)
            } catch is CancellationError {
                return
            } catch {
                guard requestGeneration == generation else { return }
                errorMessage = Self.message(for: error)
            }
        }
        pageTask = task
        return task
    }

    /// Grid hook: prefetches the next page when one of the last loaded cells appears.
    func loadMoreIfNeeded(after id: Int) {
        guard nextCursor != nil,
              let index = records.lastIndex(where: { $0.id == id }),
              index >= records.count - 12 else { return }
        loadMore()
    }

    /// Refreshes only the counts (for the Library's Review entry) with a one-photo request.
    func refreshCounts() async {
        guard pendingIDs.isEmpty else {
            countsStale = true
            return
        }
        do {
            let response = try await api.junkReview(reason: nil, limit: 1, cursor: nil)
            adopt(response.counts)
        } catch is CancellationError {
            return
        } catch {
            // The badge is advisory; the Review screen reports load failures itself.
        }
    }

    // MARK: - Decisions

    /// Rejects or keeps the listed photos that are currently shown. Ids not in the list are
    /// ignored, so bulk actions never touch photos that were not loaded.
    @discardableResult
    func resolve(_ ids: [Int], action: JunkAction) -> Task<Void, Never>? {
        let requested = Set(ids)
        let order = records.map(\.id)
        let removed = records.filter { requested.contains($0.id) }
        guard !removed.isEmpty else { return nil }
        errorMessage = nil
        records.removeAll { requested.contains($0.id) }
        selectedIDs.subtract(requested)
        let removedIDs = removed.map(\.id)
        pendingIDs.formUnion(removedIDs)
        for record in removed { counts.adjust(reasons: record.junkReasons, by: -1) }
        let requestGeneration = generation

        return Task { [api] in
            var settled = Set<Int>()
            do {
                let batchSize = CollectionName.maximumPhotoBatch
                for start in stride(from: 0, to: removedIDs.count, by: batchSize) {
                    let batch = Array(removedIDs[start..<min(start + batchSize, removedIDs.count)])
                    _ = try await api.resolveJunk(ids: batch, action: action)
                    settled.formUnion(batch)
                }
            } catch {
                restore(
                    removed.filter { !settled.contains($0.id) },
                    order: order,
                    generation: requestGeneration
                )
                if !(error is CancellationError) { errorMessage = Self.message(for: error) }
            }
            if action == .reject {
                curation.adoptConfirmed(flag: .reject, for: removed.filter { settled.contains($0.id) })
            }
            pendingIDs.subtract(removedIDs)
            settleIfIdle()
        }
    }

    /// Loupe Reject/Keep: resolves the open photo and advances to the photo that takes its
    /// place (the previous one at the end); the loupe closes when nothing is left.
    @discardableResult
    func resolveActive(_ action: JunkAction) -> Task<Void, Never>? {
        guard let id = activePhotoID, records.contains(where: { $0.id == id }) else { return nil }
        let previousOrder = records.map(\.id)
        let task = resolve([id], action: action)
        activePhotoID = PhotoIDAnchor.resolve(
            previousID: id,
            previousOrderedIDs: previousOrder,
            nextOrderedIDs: records.map(\.id)
        )
        return task
    }

    /// "Reject All" / "Keep All": acts on exactly the photos currently loaded.
    @discardableResult
    func resolveAll(_ action: JunkAction) -> Task<Void, Never>? {
        resolve(records.map(\.id), action: action)
    }

    @discardableResult
    func resolveSelected(_ action: JunkAction) -> Task<Void, Never>? {
        let ids = records.map(\.id).filter(selectedIDs.contains)
        endSelection()
        return resolve(ids, action: action)
    }

    func dismissError() {
        errorMessage = nil
    }

    // MARK: - Selection

    func beginSelection() {
        isSelecting = true
        selectedIDs.removeAll()
    }

    func endSelection() {
        isSelecting = false
        selectedIDs.removeAll()
    }

    /// Grid tap: toggles selection in select mode, otherwise opens the loupe.
    func activate(_ id: Int) {
        guard isSelecting else {
            activePhotoID = id
            return
        }
        if selectedIDs.contains(id) {
            selectedIDs.remove(id)
        } else {
            selectedIDs.insert(id)
        }
    }

    // MARK: - Private

    private func makeRecords(_ photos: [PhotoDTO], excluding excluded: Set<Int>) -> [PhotoRecord] {
        var seen = excluded
        var result: [PhotoRecord] = []
        result.reserveCapacity(photos.count)
        for photo in photos where seen.insert(photo.id).inserted {
            result.append(PhotoRecord(dto: photo, apiBaseURL: api.baseURL))
        }
        return curation.overlay(result)
    }

    private func adopt(_ serverCounts: JunkCountsDTO) {
        if pendingIDs.isEmpty {
            counts = serverCounts
            countsStale = false
        } else {
            countsStale = true
        }
    }

    /// Puts failed photos back. Counts were only changed locally, so they are always
    /// restored; the photos return to their pre-removal positions when the list is still the
    /// one they were removed from, otherwise the list reloads once decisions settle.
    private func restore(_ failed: [PhotoRecord], order: [Int], generation requestGeneration: Int) {
        guard !failed.isEmpty else { return }
        for record in failed { counts.adjust(reasons: record.junkReasons, by: 1) }
        guard requestGeneration == generation else {
            needsReload = true
            return
        }
        let rank = Dictionary(order.enumerated().map { ($1, $0) }, uniquingKeysWith: { first, _ in first })
        let merged = records + failed
        records = merged.indices
            .sorted { lhs, rhs in
                let left = rank[merged[lhs].id] ?? Int.max
                let right = rank[merged[rhs].id] ?? Int.max
                return left == right ? lhs < rhs : left < right
            }
            .map { merged[$0] }
    }

    private func settleIfIdle() {
        guard pendingIDs.isEmpty else { return }
        if needsReload || (records.isEmpty && nextCursor != nil) {
            load()
        } else if countsStale {
            countsStale = false
            Task { await refreshCounts() }
        }
    }

    static func message(for error: Error) -> String {
        (error as? LocalizedError)?.errorDescription ?? error.localizedDescription
    }
}
