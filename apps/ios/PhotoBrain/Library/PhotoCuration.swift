import Foundation

/// A photo's culling state: star rating 0-5 and an optional pick/reject flag.
struct PhotoCuration: Equatable, Sendable {
    var rating: Int
    var flag: PhotoFlag?

    init(rating: Int, flag: PhotoFlag?) {
        self.rating = rating
        self.flag = flag
    }

    init(_ record: PhotoRecord) {
        self.init(rating: record.rating, flag: record.flag)
    }
}

/// A partial curation change. `rating: nil` / `flag: nil` leave the field unchanged;
/// `flag: .some(nil)` clears the flag.
struct CurationPatch: Equatable, Sendable {
    var rating: Int?
    var flag: PhotoFlag??

    init(rating: Int? = nil, flag: PhotoFlag?? = nil) {
        self.rating = rating
        self.flag = flag
    }

    var isEmpty: Bool { rating == nil && flag == nil }

    /// Fields set on `newer` win; fields it leaves unchanged keep this patch's value.
    func merging(_ newer: CurationPatch) -> CurationPatch {
        CurationPatch(rating: newer.rating ?? rating, flag: newer.flag ?? flag)
    }

    func applied(to curation: PhotoCuration) -> PhotoCuration {
        var result = curation
        if let rating { result.rating = rating }
        if case let .some(flag) = flag { result.flag = flag }
        return result
    }

    /// Star tap: choosing the current rating again clears it to 0.
    static func toggledRating(_ stars: Int, current: PhotoCuration) -> CurationPatch {
        CurationPatch(rating: current.rating == stars ? 0 : stars)
    }

    /// Pick/Reject tap: choosing the current flag again clears it.
    static func toggledFlag(_ flag: PhotoFlag, current: PhotoCuration) -> CurationPatch {
        CurationPatch(flag: .some(current.flag == flag ? nil : flag))
    }
}

/// A store that displays photo records and accepts single-record curation updates in place.
@MainActor
protocol CurationApplying: AnyObject {
    func applyCuration(id: Int, curation: PhotoCuration)
}

/// Owns optimistic rating/flag edits for every store showing the same photos.
///
/// Each photo has at most one PATCH in flight. Intents made while a request is running are
/// merged into a single pending patch and sent when it settles, so the server's final state
/// always matches the user's last intent. Success adopts the server's values; failure rolls
/// back to the last confirmed values (plus any newer pending intent) and surfaces an error.
@MainActor
final class PhotoCurationCenter: ObservableObject {
    @Published private(set) var errorMessage: String?

    private struct State {
        var confirmed: PhotoCuration
        var inFlight: CurationPatch?
        var pending: CurationPatch?

        var displayed: PhotoCuration {
            var value = confirmed
            if let inFlight { value = inFlight.applied(to: value) }
            if let pending { value = pending.applied(to: value) }
            return value
        }
    }

    private struct WeakStore {
        weak var store: (any CurationApplying)?
    }

    private let api: any PhotoBrainAPI
    private var states: [Int: State] = [:]
    private var drains: [Int: Task<Void, Never>] = [:]
    private var stores: [WeakStore] = []

    init(api: any PhotoBrainAPI) {
        self.api = api
    }

    func register(_ store: any CurationApplying) {
        stores.removeAll { $0.store == nil || $0.store === store }
        stores.append(WeakStore(store: store))
    }

    /// Applies `patch` to `record` optimistically in every registered store and syncs it.
    /// Returns the task that settles every outstanding intent for the photo.
    @discardableResult
    func update(_ record: PhotoRecord, patch: CurationPatch) -> Task<Void, Never>? {
        guard !patch.isEmpty else { return nil }
        errorMessage = nil
        var state = states[record.id] ?? State(confirmed: PhotoCuration(record))
        state.pending = state.pending.map { $0.merging(patch) } ?? patch
        states[record.id] = state
        publish(id: record.id, curation: state.displayed)

        if let drain = drains[record.id] { return drain }
        let id = record.id
        let drain = Task { [weak self] in
            guard let self else { return }
            await self.drain(id: id)
        }
        drains[id] = drain
        return drain
    }

    func dismissError() {
        errorMessage = nil
    }

    /// Re-applies outstanding intents to freshly fetched records so a reload that races a
    /// PATCH never flashes the server's pre-edit values.
    func overlay(_ records: [PhotoRecord]) -> [PhotoRecord] {
        guard !states.isEmpty else { return records }
        return records.map { record in
            guard let displayed = states[record.id]?.displayed else { return record }
            var updated = record
            updated.rating = displayed.rating
            updated.flag = displayed.flag
            return updated
        }
    }

    private func drain(id: Int) async {
        while var state = states[id], let patch = state.pending {
            state.pending = nil
            state.inFlight = patch
            states[id] = state
            do {
                let photo = try await api.updateCuration(id: id, rating: patch.rating, flag: patch.flag)
                states[id]?.confirmed = PhotoCuration(rating: photo.rating, flag: photo.flag)
            } catch is CancellationError {
                // Outcome unknown; fall back to the last confirmed values without an alert.
            } catch {
                errorMessage = (error as? LocalizedError)?.errorDescription ?? error.localizedDescription
            }
            states[id]?.inFlight = nil
            if let settled = states[id] {
                publish(id: id, curation: settled.displayed)
            }
        }
        states[id] = nil
        drains[id] = nil
    }

    private func publish(id: Int, curation: PhotoCuration) {
        stores.removeAll { $0.store == nil }
        for entry in stores {
            entry.store?.applyCuration(id: id, curation: curation)
        }
    }
}
