import Foundation

/// Display and VoiceOver text for a person.
enum PersonLabel {
    /// Shown in place of the name of a person nobody has named yet.
    static let unnamedTitle = "Add a name"

    static func displayName(_ person: PersonDTO) -> String {
        person.name ?? unnamedTitle
    }

    /// "{name}, {n} photos", or "Unnamed person, {n} photos" without a name.
    static func accessibilityLabel(_ person: PersonDTO) -> String {
        accessibilityLabel(name: person.name, photoCount: person.photoCount)
    }

    static func accessibilityLabel(name: String?, photoCount: Int) -> String {
        if let name {
            "\(name), \(CountText.photos(photoCount))"
        } else {
            "Unnamed person, \(CountText.photos(photoCount))"
        }
    }

    /// The uppercased first letter of the name, for avatars without a cover face.
    static func initial(_ name: String?) -> String? {
        name?.first.map { String($0).uppercased() }
    }

    static func photoCountText(_ count: Int) -> String {
        count == 1 ? "1 Photo" : "\(count.formatted()) Photos"
    }

    /// The info sheet's title for one face: its person's name, "Add a name" for an unnamed
    /// person, or "Unknown" for a face without a person.
    static func faceTitle(_ face: PhotoFaceDTO) -> String {
        if face.personId != nil || face.personName != nil {
            return face.personName ?? unnamedTitle
        }
        return "Unknown"
    }

    /// Secondary text for a face without a person, explaining why.
    static func faceDetail(_ face: PhotoFaceDTO) -> String? {
        guard face.personId == nil, face.personName == nil else { return nil }
        return face.assignment == .rejected ? "Removed from people" : "Not grouped yet"
    }

    /// VoiceOver text for a face row: "{name}" or "Unnamed person" plus its position.
    static func faceAccessibilityLabel(_ face: PhotoFaceDTO, index: Int, count: Int) -> String {
        let who: String
        if face.personId != nil || face.personName != nil {
            who = face.personName ?? "Unnamed person"
        } else {
            who = face.assignment == .rejected ? "Unknown person, removed from people" : "Unknown person"
        }
        return "\(who), face \(index + 1) of \(count)"
    }
}

/// Owns the people list and its mutations. The list keeps the server's order (named first,
/// then photo count); rename, hide, and merge apply optimistically and roll back (surfacing
/// `errorMessage`) when the server rejects them.
@MainActor
final class PeopleStore: ObservableObject {
    enum LoadState: Equatable {
        case idle
        case loading
        case loaded
        case failed(String)
    }

    /// How many people the Collections tab shows before See All.
    static let featuredLimit = 12

    @Published private(set) var people: [PersonDTO] = []
    @Published private(set) var loadState: LoadState = .idle
    @Published private(set) var errorMessage: String?
    /// Whether the list includes hidden people (the People screen's Show Hidden toggle).
    @Published private(set) var includeHidden = false

    let api: any PhotoBrainAPI
    private var loadTask: Task<Void, Never>?
    /// Bumped by every load and every mutation; older list responses are discarded.
    private var generation = 0

    init(api: any PhotoBrainAPI) {
        self.api = api
    }

    /// The first visible (not hidden) people in server order, for the Collections tab.
    var featured: [PersonDTO] {
        Array(people.lazy.filter { !$0.hidden }.prefix(Self.featuredLimit))
    }

    func person(id: Int) -> PersonDTO? {
        people.first { $0.id == id }
    }

    /// People whose name contains `search` (case- and diacritic-insensitive), in list order.
    /// A blank search matches everyone; unnamed people only match a blank search.
    func matching(_ search: String) -> [PersonDTO] {
        let trimmed = search.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return people }
        return people.filter { $0.name?.localizedStandardContains(trimmed) == true }
    }

    func dismissError() {
        errorMessage = nil
    }

    /// Refreshes the list. A failure before any successful load becomes `.failed`; later
    /// failures keep the current list and surface `errorMessage`.
    func load() async {
        generation += 1
        let requestGeneration = generation
        let includeHidden = includeHidden
        loadTask?.cancel()
        if loadState != .loaded { loadState = .loading }
        let task = Task { [api] in
            do {
                let response = try await api.people(includeHidden: includeHidden)
                guard !Task.isCancelled, requestGeneration == generation else { return }
                people = response.people
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

    /// Shows or hides hidden people, reloading the list when the choice changes.
    func setIncludeHidden(_ value: Bool) async {
        guard value != includeHidden else { return }
        includeHidden = value
        await load()
    }

    /// Reloads without waiting, e.g. after a face assignment changed photo counts.
    func refreshInBackground() {
        Task { [weak self] in await self?.load() }
    }

    /// Shows the new name immediately; restores the previous entry if the server rejects it.
    /// A blank name clears the name.
    @discardableResult
    func rename(id: Int, to raw: String) async -> Bool {
        errorMessage = nil
        let name: String?
        do {
            name = try PersonName.validatedOptional(raw)
        } catch {
            errorMessage = CollectionsStore.message(for: error)
            return false
        }
        guard let index = index(of: id) else { return false }
        let previous = people[index]
        guard previous.name != name else { return true }
        supersedeLoad()
        people[index].name = name
        do {
            let confirmed = try await api.updatePerson(id: id, name: .some(name), hidden: nil)
            supersedeLoad()
            apply(confirmed)
            return true
        } catch {
            supersedeLoad()
            restore([(index, previous)])
            handleMutationFailure(error)
            return false
        }
    }

    /// Hides or unhides immediately. While hidden people are excluded, hiding removes the
    /// entry; a failure puts it back where it was.
    @discardableResult
    func setHidden(id: Int, _ hidden: Bool) async -> Bool {
        errorMessage = nil
        guard let index = index(of: id) else { return false }
        let previous = people[index]
        guard previous.hidden != hidden else { return true }
        supersedeLoad()
        if hidden, !includeHidden {
            people.remove(at: index)
        } else {
            people[index].hidden = hidden
        }
        do {
            let confirmed = try await api.updatePerson(id: id, name: nil, hidden: hidden)
            supersedeLoad()
            apply(confirmed)
            return true
        } catch {
            supersedeLoad()
            restore([(index, previous)])
            handleMutationFailure(error)
            return false
        }
    }

    /// Folds `sourceIds` into `targetId` immediately: the sources disappear and the target
    /// takes their counts (and the first named source's name when it has none). The server's
    /// target replaces the estimate on success; a failure restores every entry in place.
    @discardableResult
    func merge(targetId: Int, sourceIds: [Int]) async -> Bool {
        errorMessage = nil
        guard PeopleMerge.isValid(targetId: targetId, sourceIds: sourceIds) else {
            errorMessage = "Choose between 1 and \(PeopleMerge.maximumSources) other people to merge."
            return false
        }
        guard let targetIndex = index(of: targetId) else { return false }
        let target = people[targetIndex]
        let sources: [(Int, PersonDTO)] = sourceIds.compactMap { id in
            index(of: id).map { ($0, people[$0]) }
        }
        supersedeLoad()
        var merged = target
        for (_, source) in sources {
            merged.photoCount += source.photoCount
            merged.faceCount += source.faceCount
            if merged.name == nil { merged.name = source.name }
            if merged.coverFaceId == nil { merged.coverFaceId = source.coverFaceId }
        }
        people[targetIndex] = merged
        let removed = Set(sourceIds)
        people.removeAll { removed.contains($0.id) }
        do {
            let confirmed = try await api.mergePeople(targetId: targetId, sourceIds: sourceIds)
            supersedeLoad()
            apply(confirmed)
            return true
        } catch {
            supersedeLoad()
            restore([(targetIndex, target)] + sources)
            handleMutationFailure(error)
            return false
        }
    }

    private func index(of id: Int) -> Int? {
        people.firstIndex { $0.id == id }
    }

    /// Replaces a confirmed entry in place; drops it when it is now hidden and hidden people
    /// are excluded. Entries removed meanwhile stay removed.
    private func apply(_ confirmed: PersonDTO) {
        guard let index = index(of: confirmed.id) else { return }
        if confirmed.hidden, !includeHidden {
            people.remove(at: index)
        } else {
            people[index] = confirmed
        }
    }

    /// Puts entries back at their previous positions, replacing any current copy.
    private func restore(_ entries: [(Int, PersonDTO)]) {
        for (position, person) in entries.sorted(by: { $0.0 < $1.0 }) {
            if let index = index(of: person.id) {
                people[index] = person
            } else {
                people.insert(person, at: min(position, people.count))
            }
        }
    }

    private func handleMutationFailure(_ error: Error) {
        // A cancelled request has an unknown outcome; roll back silently.
        guard !(error is CancellationError) else { return }
        errorMessage = CollectionsStore.message(for: error)
        if (error as? PhotoBrainAPIError)?.code == "PERSON_NOT_FOUND" { refreshInBackground() }
    }

    /// A local mutation is newer than any list response still in flight. If the list was
    /// never loaded, fetch it now so the mutated entry is not the only one shown.
    private func supersedeLoad() {
        generation += 1
        loadTask?.cancel()
        loadTask = nil
        if loadState != .loaded { refreshInBackground() }
    }
}

/// One photo's faces for the info sheet. Assignments apply optimistically and roll back
/// (surfacing `errorMessage`) when the server rejects them.
@MainActor
final class PhotoFacesStore: ObservableObject {
    enum State: Equatable {
        case loading
        case loaded([PhotoFaceDTO])
        case failed(String)
    }

    @Published private(set) var state: State = .loading
    @Published private(set) var errorMessage: String?
    /// Faces with an assignment in flight; their rows are disabled until it settles.
    @Published private(set) var pendingFaceIDs: Set<Int> = []

    let photoID: Int
    let api: any PhotoBrainAPI
    /// Called after the server confirms an assignment, e.g. to refresh people counts.
    var onAssigned: (() -> Void)?

    init(photoID: Int, api: any PhotoBrainAPI) {
        self.photoID = photoID
        self.api = api
    }

    var faces: [PhotoFaceDTO] {
        if case let .loaded(faces) = state { return faces }
        return []
    }

    func dismissError() {
        errorMessage = nil
    }

    func load() async {
        state = .loading
        do {
            let response = try await api.photoFaces(photoId: photoID)
            guard !Task.isCancelled else { return }
            state = .loaded(response.faces)
        } catch is CancellationError {
            return
        } catch {
            state = .failed(CollectionsStore.message(for: error))
        }
    }

    /// Assigns a face: to an existing person (`displayName` is that person's name, shown until
    /// the server confirms), to a new named person, or rejects it. Invalid input (a blank new
    /// name) sends no request.
    @discardableResult
    func assign(faceId: Int, to requested: FaceAssignmentTarget, displayName: String? = nil) async -> Bool {
        errorMessage = nil
        let target: FaceAssignmentTarget
        do {
            target = try requested.validated()
        } catch {
            errorMessage = CollectionsStore.message(for: error)
            return false
        }
        guard !pendingFaceIDs.contains(faceId), let previous = face(id: faceId) else { return false }
        var optimistic = previous
        switch target {
        case let .person(id):
            optimistic.personId = id
            optimistic.personName = displayName
            optimistic.assignment = .manual
        case let .newPerson(name):
            optimistic.personId = nil
            optimistic.personName = name
            optimistic.assignment = .manual
        case .notThisPerson:
            optimistic.personId = nil
            optimistic.personName = nil
            optimistic.assignment = .rejected
        }
        replace(optimistic)
        pendingFaceIDs.insert(faceId)
        defer { pendingFaceIDs.remove(faceId) }
        do {
            let confirmed = try await api.assignFace(faceId: faceId, to: target)
            replace(confirmed)
            onAssigned?()
            return true
        } catch {
            if (error as? PhotoBrainAPIError)?.code == "FACE_NOT_FOUND" {
                remove(faceId)
            } else {
                replace(previous)
            }
            guard !(error is CancellationError) else { return false }
            errorMessage = CollectionsStore.message(for: error)
            if (error as? PhotoBrainAPIError)?.code == "PERSON_NOT_FOUND" { onAssigned?() }
            return false
        }
    }

    private func face(id: Int) -> PhotoFaceDTO? {
        faces.first { $0.id == id }
    }

    private func replace(_ face: PhotoFaceDTO) {
        guard case var .loaded(faces) = state, let index = faces.firstIndex(where: { $0.id == face.id }) else { return }
        faces[index] = face
        state = .loaded(faces)
    }

    private func remove(_ faceId: Int) {
        guard case var .loaded(faces) = state else { return }
        faces.removeAll { $0.id == faceId }
        state = .loaded(faces)
    }
}

/// The loupe's Show Faces toggle: face boxes for the photos paged to while it is on, cached
/// per photo for the loupe's lifetime. Videos have no faces and are never requested.
@MainActor
final class LoupeFaceBoxesStore: ObservableObject {
    @Published private(set) var isShowing = false
    @Published private(set) var boxesByPhoto: [Int: [FaceBoxDTO]] = [:]
    /// Photos whose faces failed to load; paging back retries them.
    @Published private(set) var failedPhotoIDs: Set<Int> = []

    let api: any PhotoBrainAPI
    private var inFlight: Set<Int> = []

    init(api: any PhotoBrainAPI) {
        self.api = api
    }

    /// What the pager draws: every loaded photo's boxes while showing, nothing otherwise.
    var visibleBoxes: [Int: [FaceBoxDTO]] {
        isShowing ? boxesByPhoto : [:]
    }

    /// `nil` while loading or for a photo whose faces failed to load.
    func faceCount(photoID: Int) -> Int? {
        boxesByPhoto[photoID]?.count
    }

    /// Turns the overlay on or off, loading `photo`'s faces when turning on.
    func setShowing(_ showing: Bool, photo: PhotoRecord?) async {
        isShowing = showing
        guard showing else { return }
        await load(photo)
    }

    /// Loads `photo`'s faces once while the overlay is on.
    func load(_ photo: PhotoRecord?) async {
        guard isShowing, let photo, !photo.isVideo,
              boxesByPhoto[photo.id] == nil, !inFlight.contains(photo.id) else { return }
        inFlight.insert(photo.id)
        defer { inFlight.remove(photo.id) }
        do {
            let response = try await api.photoFaces(photoId: photo.id)
            failedPhotoIDs.remove(photo.id)
            boxesByPhoto[photo.id] = response.faces.map(\.box)
        } catch {
            if !(error is CancellationError) { failedPhotoIDs.insert(photo.id) }
        }
    }
}
