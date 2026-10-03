import Foundation

/// One duplicate or burst group as shown on the Duplicates screen, with the user's keep choice.
struct DuplicateGroup: Identifiable, Equatable, Sendable {
    let key: String
    let kind: DuplicateKind
    /// Keeper first, then id ascending (server order).
    var photos: [PhotoRecord]
    let suggestedKeeperID: Int
    let maxDistance: Int?
    /// Never empty: the last kept photo cannot be unkept.
    private(set) var keepIDs: Set<Int>

    var id: String { key }

    init(dto: DuplicateGroupDTO, records: [PhotoRecord]) {
        key = dto.key
        kind = dto.kind
        photos = records
        suggestedKeeperID = dto.suggestedKeeperId
        maxDistance = dto.maxDistance
        let ids = Set(records.map(\.id))
        let keeper = ids.contains(dto.suggestedKeeperId) ? dto.suggestedKeeperId : records.first?.id
        keepIDs = keeper.map { [$0] } ?? []
    }

    /// Kept photo ids in display order.
    var keptIDs: [Int] { photos.map(\.id).filter(keepIDs.contains) }
    /// Photos that "Keep N, reject M" would reject, in display order.
    var rejectedIDs: [Int] { photos.map(\.id).filter { !keepIDs.contains($0) } }

    /// Toggles whether `id` is kept. Returns false (and changes nothing) for a non-member or for
    /// the last kept photo, so at least one photo always remains kept.
    @discardableResult
    mutating func toggleKeep(_ id: Int) -> Bool {
        guard photos.contains(where: { $0.id == id }) else { return false }
        if keepIDs.contains(id) {
            guard keepIDs.count > 1 else { return false }
            keepIDs.remove(id)
        } else {
            keepIDs.insert(id)
        }
        return true
    }

    /// Re-applies an earlier keep choice for the same membership; ignored if it keeps nothing.
    mutating func restoreKeepIDs(_ ids: Set<Int>) {
        let members = ids.intersection(photos.map(\.id))
        if !members.isEmpty { keepIDs = members }
    }
}

/// Backs the Duplicates screen: one kind-filtered, cursor-paginated group list plus server-wide
/// group counts, with optimistic keep/dismiss decisions.
///
/// Resolving removes the group and decrements its kind's count immediately. A failed request
/// puts the group back in its original position and surfaces an error. A stale group
/// (`409 DUPLICATE_GROUP_CHANGED`) is not restored: the list reloads and a notice explains why.
/// Confirmed rejections are published through `PhotoCurationCenter` so every other store shows
/// the reject flag. While decisions are in flight, server counts from page loads are not
/// adopted and further pages are deferred; both catch up once every decision has settled.
@MainActor
final class DuplicatesStore: ObservableObject, CurationApplying {
    enum LoadState: Equatable {
        case idle
        case loading
        case loaded
        case failed(String)
    }

    /// The group whose photos are open in the comparison loupe.
    struct Comparison: Equatable {
        let key: String
        var photoID: Int
    }

    static let pageSize = 50

    @Published private(set) var state: LoadState = .idle
    @Published private(set) var groups: [DuplicateGroup] = []
    @Published private(set) var counts: DuplicateCountsDTO = .zero
    @Published private(set) var kind: DuplicateKind?
    @Published private(set) var nextCursor: String?
    @Published private(set) var isLoadingMore = false
    @Published private(set) var errorMessage: String?
    /// Explains a reload caused by a stale group; survives that reload.
    @Published private(set) var notice: String?
    @Published var comparison: Comparison?

    let api: any PhotoBrainAPI
    let curation: PhotoCurationCenter
    private var loadTask: Task<Void, Never>?
    private var pageTask: Task<Void, Never>?
    /// Bumped whenever the list is replaced; late responses for an older list are dropped.
    private var generation = 0
    /// Groups with a decision in flight; never re-added by page loads.
    private var pendingKeys: Set<String> = []
    /// Groups the server removed since `nextCursor` was issued. The cursor is an offset, so
    /// following it would skip that many unseen groups; the next page refetches from the top.
    private var removedSinceCursor = 0
    private var countsStale = false
    private var needsReload = false
    private var wantsMore = false

    init(api: any PhotoBrainAPI, curation: PhotoCurationCenter? = nil) {
        self.api = api
        self.curation = curation ?? PhotoCurationCenter(api: api)
        self.curation.register(self)
    }

    /// "No duplicates": the loaded list is exhausted with no further page.
    var isEmpty: Bool {
        state == .loaded && groups.isEmpty && nextCursor == nil
    }

    func group(for key: String) -> DuplicateGroup? {
        groups.first { $0.key == key }
    }

    func applyCuration(id: Int, curation: PhotoCuration) {
        for index in groups.indices {
            groups[index].photos.applyCuration(id: id, curation: curation)
        }
    }

    // MARK: - Loading

    /// Replaces the list with the first page for the current kind. Pull-to-refresh keeps the
    /// current groups visible until the response arrives.
    @discardableResult
    func load(retainingContent: Bool = true) -> Task<Void, Never> {
        fetchFromTop(limit: Self.pageSize, retainingContent: retainingContent, isPageLoad: false)
    }

    /// Switches the kind filter (`nil` = All) and reloads from the first page.
    func setKind(_ kind: DuplicateKind?) {
        guard kind != self.kind else { return }
        self.kind = kind
        comparison = nil
        load(retainingContent: false)
    }

    /// Fetches the page after `nextCursor`, appending only groups not already listed.
    @discardableResult
    func loadMore() -> Task<Void, Never>? {
        guard state == .loaded, !isLoadingMore, let cursor = nextCursor else { return nil }
        guard pendingKeys.isEmpty else {
            wantsMore = true
            return nil
        }
        wantsMore = false
        if removedSinceCursor > 0 {
            // Offsets moved under the cursor: refetch everything listed plus one more page.
            return fetchFromTop(
                limit: min(DuplicateGroupsResponseDTO.maximumLimit, groups.count + Self.pageSize),
                retainingContent: true,
                isPageLoad: true
            )
        }
        isLoadingMore = true
        let requestGeneration = generation
        let kind = kind
        let task = Task { [api] in
            defer { if requestGeneration == generation { isLoadingMore = false } }
            do {
                let response = try await api.duplicateGroups(kind: kind, limit: Self.pageSize, cursor: cursor)
                guard !Task.isCancelled, requestGeneration == generation else { return }
                groups.append(contentsOf: makeGroups(
                    response.groups,
                    excluding: pendingKeys.union(groups.map(\.key))
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

    /// List hook: prefetches the next page when one of the last loaded groups appears.
    func loadMoreIfNeeded(after key: String) {
        guard nextCursor != nil,
              let index = groups.lastIndex(where: { $0.key == key }),
              index >= groups.count - 5 else { return }
        loadMore()
    }

    /// Refreshes only the counts (for the Library's Duplicates entry) with a one-group request.
    func refreshCounts() async {
        guard pendingKeys.isEmpty else {
            countsStale = true
            return
        }
        do {
            let response = try await api.duplicateGroups(kind: nil, limit: 1, cursor: nil)
            adopt(response.counts)
        } catch is CancellationError {
            return
        } catch {
            // The badge is advisory; the Duplicates screen reports load failures itself.
        }
    }

    // MARK: - Decisions

    /// Tap on a thumbnail: toggles whether the photo is kept. The last kept photo stays kept.
    @discardableResult
    func toggleKeep(groupKey: String, photoID: Int) -> Bool {
        guard let index = groups.firstIndex(where: { $0.key == groupKey }) else { return false }
        return groups[index].toggleKeep(photoID)
    }

    /// "Keep N, reject M": keeps the chosen photos and rejects every other member.
    @discardableResult
    func keepSelected(groupKey: String) -> Task<Void, Never>? {
        guard let group = group(for: groupKey), !group.rejectedIDs.isEmpty else { return nil }
        return resolve(group, resolution: .keep(group.keptIDs))
    }

    /// "Not duplicates": hides this exact group for good without changing any photo.
    @discardableResult
    func dismiss(groupKey: String) -> Task<Void, Never>? {
        guard let group = group(for: groupKey) else { return nil }
        return resolve(group, resolution: .dismiss)
    }

    func dismissError() {
        errorMessage = nil
    }

    func dismissNotice() {
        notice = nil
    }

    /// Opens the comparison loupe on `photoID` within its group.
    func compare(groupKey: String, photoID: Int) {
        guard let group = group(for: groupKey), group.photos.contains(where: { $0.id == photoID }) else { return }
        comparison = Comparison(key: groupKey, photoID: photoID)
    }

    // MARK: - Private

    private func resolve(_ group: DuplicateGroup, resolution: DuplicateResolution) -> Task<Void, Never> {
        let order = groups.map(\.key)
        errorMessage = nil
        notice = nil
        groups.removeAll { $0.key == group.key }
        if comparison?.key == group.key { comparison = nil }
        pendingKeys.insert(group.key)
        counts.adjust(group.kind, by: -1)
        let requestGeneration = generation

        return Task { [api] in
            do {
                let response = try await api.resolveDuplicateGroup(key: group.key, resolution: resolution)
                if case .keep = resolution {
                    let rejected = Set(response.rejected ?? group.rejectedIDs)
                    let records = group.photos.filter { rejected.contains($0.id) }
                    curation.adoptConfirmed(flag: .reject, for: records)
                    // Groups sharing a rejected photo changed membership on the server.
                    if groups.contains(where: { $0.photos.contains { rejected.contains($0.id) } }) {
                        needsReload = true
                    }
                }
                if requestGeneration == generation { removedSinceCursor += 1 }
            } catch PhotoBrainAPIError.duplicateGroupChanged {
                notice = PhotoBrainAPIError.duplicateGroupChanged.errorDescription
                needsReload = true
                countsStale = true
            } catch {
                restore(group, order: order, generation: requestGeneration)
                if !(error is CancellationError) { errorMessage = Self.message(for: error) }
            }
            pendingKeys.remove(group.key)
            settleIfIdle()
        }
    }

    /// Replaces the list with the first `limit` groups. `isPageLoad` shows the load-more spinner
    /// instead of the full-screen loading state.
    private func fetchFromTop(limit: Int, retainingContent: Bool, isPageLoad: Bool) -> Task<Void, Never> {
        generation += 1
        let requestGeneration = generation
        loadTask?.cancel()
        pageTask?.cancel()
        isLoadingMore = isPageLoad
        needsReload = false
        if groups.isEmpty || !retainingContent {
            groups = []
            state = .loading
        }
        let kind = kind
        let task = Task { [api] in
            defer { if requestGeneration == generation { isLoadingMore = false } }
            do {
                let response = try await api.duplicateGroups(kind: kind, limit: limit, cursor: nil)
                guard !Task.isCancelled, requestGeneration == generation else { return }
                let previous = Dictionary(groups.map { ($0.key, $0.keepIDs) }, uniquingKeysWith: { first, _ in first })
                groups = makeGroups(response.groups, excluding: pendingKeys).map { fresh in
                    // A refetch keeps the user's keep choices for groups that are unchanged.
                    var group = fresh
                    if let keepIDs = previous[fresh.key] { group.restoreKeepIDs(keepIDs) }
                    return group
                }
                nextCursor = response.nextCursor
                removedSinceCursor = 0
                adopt(response.counts)
                if let comparison, group(for: comparison.key) == nil { self.comparison = nil }
                errorMessage = nil
                state = .loaded
            } catch is CancellationError {
                return
            } catch {
                guard requestGeneration == generation else { return }
                let message = Self.message(for: error)
                if groups.isEmpty {
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

    private func makeGroups(_ dtos: [DuplicateGroupDTO], excluding excluded: Set<String>) -> [DuplicateGroup] {
        var seen = excluded
        var result: [DuplicateGroup] = []
        result.reserveCapacity(dtos.count)
        for dto in dtos where seen.insert(dto.key).inserted {
            let records = curation.overlay(dto.photos.map { PhotoRecord(dto: $0, apiBaseURL: api.baseURL) })
            guard records.count >= 2 else { continue }
            result.append(DuplicateGroup(dto: dto, records: records))
        }
        return result
    }

    private func adopt(_ serverCounts: DuplicateCountsDTO) {
        if pendingKeys.isEmpty {
            counts = serverCounts
            countsStale = false
        } else {
            countsStale = true
        }
    }

    /// Puts a failed group back. Its count was only changed locally, so it is always restored;
    /// the group returns to its pre-removal position when the list is still the one it was
    /// removed from, otherwise the list reloads once decisions settle.
    private func restore(_ group: DuplicateGroup, order: [String], generation requestGeneration: Int) {
        counts.adjust(group.kind, by: 1)
        guard requestGeneration == generation else {
            needsReload = true
            return
        }
        let rank = Dictionary(order.enumerated().map { ($1, $0) }, uniquingKeysWith: { first, _ in first })
        let target = rank[group.key] ?? Int.max
        let index = groups.firstIndex { (rank[$0.key] ?? Int.max) > target } ?? groups.endIndex
        groups.insert(group, at: index)
    }

    private func settleIfIdle() {
        guard pendingKeys.isEmpty else { return }
        if needsReload || (groups.isEmpty && nextCursor != nil) {
            load()
        } else {
            if countsStale {
                countsStale = false
                Task { await refreshCounts() }
            }
            if wantsMore { loadMore() }
        }
    }

    static func message(for error: Error) -> String {
        (error as? LocalizedError)?.errorDescription ?? error.localizedDescription
    }
}
