import SwiftUI

private struct PeopleStoreKey: EnvironmentKey {
    static let defaultValue: PeopleStore? = nil
}

extension EnvironmentValues {
    /// The app's people list, installed at the root so any loupe's info sheet can offer face
    /// assignment over the same list the Collections tab shows.
    var peopleStore: PeopleStore? {
        get { self[PeopleStoreKey.self] }
        set { self[PeopleStoreKey.self] = newValue }
    }
}

/// Navigation value for a person; detail screens read the live name from the store.
struct PersonRoute: Hashable {
    let person: PersonDTO

    static func == (lhs: Self, rhs: Self) -> Bool { lhs.person.id == rhs.person.id }
    func hash(into hasher: inout Hasher) { hasher.combine(person.id) }
}

/// Navigation value for the full People grid.
struct PeopleListRoute: Hashable {}

/// A round face crop from `/api/faces/{id}/crop`, or the name's initial (a person glyph when
/// unnamed) without a face or while the crop loads.
struct FaceCropImage: View {
    let faceID: Int?
    let apiBaseURL: URL
    let name: String?
    @State private var image: UIImage?

    var body: some View {
        GeometryReader { geometry in
            ZStack {
                Circle().fill(Color(uiColor: .tertiarySystemFill))
                if let image {
                    Image(uiImage: image)
                        .resizable()
                        .aspectRatio(contentMode: .fill)
                } else if let initial = PersonLabel.initial(name) {
                    Text(initial)
                        .font(.system(size: geometry.size.width * 0.42, weight: .semibold, design: .rounded))
                        .foregroundStyle(.secondary)
                } else {
                    Image(systemName: "person.fill")
                        .font(.system(size: geometry.size.width * 0.4))
                        .foregroundStyle(.secondary)
                }
            }
            .frame(width: geometry.size.width, height: geometry.size.height)
            .clipShape(Circle())
            .task(id: faceID) {
                image = nil
                guard let faceID else { return }
                image = try? await RedirectAwareImageLoader().image(
                    photoID: faceID,
                    url: FaceCrop.url(baseURL: apiBaseURL, faceID: faceID),
                    isConvertedRAW: false,
                    targetSize: geometry.size
                )
            }
        }
        .aspectRatio(1, contentMode: .fit)
        .accessibilityHidden(true)
    }
}

/// A person's avatar with their name (or "Add a name") and photo count. Hidden people are
/// dimmed with a badge.
struct PersonAvatarView: View {
    let person: PersonDTO
    let apiBaseURL: URL
    var diameter: CGFloat?

    var body: some View {
        VStack(spacing: 4) {
            FaceCropImage(faceID: person.coverFaceId, apiBaseURL: apiBaseURL, name: person.name)
                .frame(width: diameter, height: diameter)
                .overlay(alignment: .bottomTrailing) {
                    if person.hidden {
                        Image(systemName: "eye.slash.circle.fill")
                            .font(.title3)
                            .symbolRenderingMode(.multicolor)
                            .background(Circle().fill(Color(uiColor: .systemBackground)))
                    }
                }
                .padding(.bottom, 2)
            Text(PersonLabel.displayName(person))
                .font(.caption.weight(.semibold))
                .foregroundStyle(person.name == nil ? .secondary : .primary)
            Text(PersonLabel.photoCountText(person.photoCount))
                .font(.caption2)
                .foregroundStyle(.secondary)
        }
        .lineLimit(1)
        .opacity(person.hidden ? 0.55 : 1)
        .contentShape(Rectangle())
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(PersonLabel.accessibilityLabel(person))
        .accessibilityValue(person.hidden ? "Hidden" : "")
        .accessibilityAddTraits(.isButton)
    }
}

/// Collections-tab People section: the first visible people as horizontally scrolling round
/// avatars, plus See All. Hidden until the list first loads, unless that load failed.
struct PeopleSection<Header: View>: View {
    @ObservedObject var store: PeopleStore
    let apiBaseURL: URL
    @ViewBuilder let header: () -> Header

    var body: some View {
        switch store.loadState {
        case .idle, .loading:
            EmptyView()
        case let .failed(message):
            VStack(alignment: .leading, spacing: 8) {
                titleRow
                ErrorBanner(message: message, retry: { Task { await store.load() } })
                    .clipShape(RoundedRectangle(cornerRadius: 8))
            }
        case .loaded:
            VStack(alignment: .leading, spacing: 10) {
                titleRow
                if store.featured.isEmpty {
                    Text("Faces are grouped into people after photos are scanned.")
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                } else {
                    ScrollView(.horizontal, showsIndicators: false) {
                        LazyHStack(alignment: .top, spacing: 14) {
                            ForEach(store.featured) { person in
                                NavigationLink(value: PersonRoute(person: person)) {
                                    PersonAvatarView(person: person, apiBaseURL: apiBaseURL, diameter: 72)
                                        .frame(width: 80)
                                }
                                .buttonStyle(.plain)
                                .accessibilityHint("Shows this person’s photos")
                            }
                        }
                    }
                    .scrollClipDisabled()
                }
            }
        }
    }

    private var titleRow: some View {
        HStack(alignment: .firstTextBaseline) {
            header()
            Spacer()
            NavigationLink("See All", value: PeopleListRoute())
                .font(.subheadline)
                .accessibilityLabel("See all people")
        }
    }
}

/// Every person in a searchable grid with a Show Hidden toggle. Context menus rename, hide or
/// unhide, and start a merge; merging selects people, then picks the one to keep and confirms.
struct PeopleScreen: View {
    @ObservedObject var store: PeopleStore
    let apiBaseURL: URL

    @State private var search = ""
    @State private var isSelecting = false
    @State private var selectedIDs: Set<Int> = []
    @State private var renameTarget: PersonDTO?
    @State private var renameText = ""
    @State private var mergeCandidates: MergeCandidates?
    /// Chosen in the target picker; confirmed once the picker has dismissed.
    @State private var pendingMerge: MergePlan?
    @State private var mergePlan: MergePlan?

    private let columns = [GridItem(.adaptive(minimum: 96, maximum: 140), spacing: 14, alignment: .top)]

    private var visiblePeople: [PersonDTO] {
        store.matching(search)
    }

    var body: some View {
        content
            .navigationTitle(isSelecting ? selectionTitle : "People")
            .navigationBarTitleDisplayMode(.inline)
            .searchable(text: $search, prompt: "Search by Name")
            .safeAreaInset(edge: .top, spacing: 0) {
                if let message = store.errorMessage {
                    ErrorBanner(message: message, dismiss: { store.dismissError() })
                }
            }
            .toolbar { toolbarContent }
            .task { await store.loadIfNeeded() }
            .alert(
                renameTarget?.name == nil ? "Add a Name" : "Rename Person",
                isPresented: renamePresented,
                presenting: renameTarget
            ) { target in
                TextField("Name", text: $renameText)
                Button("Cancel", role: .cancel) {}
                Button("Save") {
                    let name = renameText
                    Task { await store.rename(id: target.id, to: name) }
                }
            } message: { _ in
                Text("Leave the name blank to remove it.")
            }
            .sheet(item: $mergeCandidates, onDismiss: {
                mergePlan = pendingMerge
                pendingMerge = nil
            }) { candidates in
                MergeTargetPicker(candidates: candidates.people, apiBaseURL: apiBaseURL) { target in
                    pendingMerge = MergePlan(
                        target: target,
                        sources: candidates.people.filter { $0.id != target.id }
                    )
                    mergeCandidates = nil
                }
            }
            .confirmationDialog(
                mergePlan.map { "Merge \($0.sources.count + 1) people into “\(PersonLabel.displayName($0.target))”?" }
                    ?? "Merge People?",
                isPresented: mergePresented,
                titleVisibility: .visible,
                presenting: mergePlan
            ) { plan in
                Button("Merge") {
                    isSelecting = false
                    selectedIDs = []
                    Task {
                        await store.merge(targetId: plan.target.id, sourceIds: plan.sources.map(\.id))
                    }
                }
                Button("Cancel", role: .cancel) {}
            } message: { _ in
                Text("All their faces move to one person. This can’t be undone.")
            }
    }

    @ViewBuilder
    private var content: some View {
        switch store.loadState {
        case .idle, .loading:
            ProgressView("Loading People…")
                .frame(maxWidth: .infinity, maxHeight: .infinity)
        case let .failed(message):
            ContentUnavailableView {
                Label("People Unavailable", systemImage: "wifi.exclamationmark")
            } description: {
                Text(message)
            } actions: {
                Button("Try Again") { Task { await store.load() } }
                    .buttonStyle(.borderedProminent)
            }
        case .loaded:
            ScrollView {
                VStack(alignment: .leading, spacing: 16) {
                    Toggle("Show Hidden", isOn: showHidden)
                        .disabled(isSelecting)
                    if visiblePeople.isEmpty {
                        emptyState
                    } else {
                        LazyVGrid(columns: columns, spacing: 18) {
                            ForEach(visiblePeople) { person in
                                cell(person)
                            }
                        }
                    }
                }
                .padding(16)
            }
            .refreshable { await store.load() }
        }
    }

    @ViewBuilder
    private var emptyState: some View {
        if search.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            ContentUnavailableView(
                "No People",
                systemImage: "person.2",
                description: Text("Faces are grouped into people after photos are scanned.")
            )
            .padding(.top, 40)
        } else {
            ContentUnavailableView.search(text: search)
                .padding(.top, 40)
        }
    }

    @ViewBuilder
    private func cell(_ person: PersonDTO) -> some View {
        if isSelecting {
            let selected = selectedIDs.contains(person.id)
            Button {
                if selected {
                    selectedIDs.remove(person.id)
                } else {
                    selectedIDs.insert(person.id)
                }
            } label: {
                PersonAvatarView(person: person, apiBaseURL: apiBaseURL)
                    .overlay(alignment: .topTrailing) {
                        Image(systemName: selected ? "checkmark.circle.fill" : "circle")
                            .font(.title2)
                            .foregroundStyle(selected ? Color.accentColor : Color.secondary)
                            .background(Circle().fill(Color(uiColor: .systemBackground)))
                    }
            }
            .buttonStyle(.plain)
            .accessibilityAddTraits(selected ? .isSelected : [])
        } else {
            NavigationLink(value: PersonRoute(person: person)) {
                PersonAvatarView(person: person, apiBaseURL: apiBaseURL)
            }
            .buttonStyle(.plain)
            .contextMenu {
                Button {
                    renameText = person.name ?? ""
                    renameTarget = person
                } label: {
                    Label(person.name == nil ? "Add Name" : "Rename", systemImage: "pencil")
                }
                Button {
                    Task { await store.setHidden(id: person.id, !person.hidden) }
                } label: {
                    Label(person.hidden ? "Unhide" : "Hide", systemImage: person.hidden ? "eye" : "eye.slash")
                }
                Button {
                    selectedIDs = [person.id]
                    isSelecting = true
                } label: {
                    Label("Merge…", systemImage: "arrow.triangle.merge")
                }
            }
        }
    }

    @ToolbarContentBuilder
    private var toolbarContent: some ToolbarContent {
        if isSelecting {
            ToolbarItem(placement: .cancellationAction) {
                Button("Cancel") {
                    isSelecting = false
                    selectedIDs = []
                }
            }
            ToolbarItem(placement: .confirmationAction) {
                Button("Merge") {
                    let selected = store.people.filter { selectedIDs.contains($0.id) }
                    mergeCandidates = MergeCandidates(people: selected)
                }
                .disabled(selectedIDs.count < 2 || selectedIDs.count > PeopleMerge.maximumSources + 1)
            }
        } else {
            ToolbarItem(placement: .topBarTrailing) {
                Button("Select") {
                    selectedIDs = []
                    isSelecting = true
                }
                .disabled(store.people.count < 2)
                .accessibilityHint("Selects people to merge")
            }
        }
    }

    private var selectionTitle: String {
        switch selectedIDs.count {
        case 0: "Select People"
        case 1: "1 Selected"
        default: "\(selectedIDs.count) Selected"
        }
    }

    private var showHidden: Binding<Bool> {
        Binding(
            get: { store.includeHidden },
            set: { value in Task { await store.setIncludeHidden(value) } }
        )
    }

    private var renamePresented: Binding<Bool> {
        Binding(get: { renameTarget != nil }, set: { if !$0 { renameTarget = nil } })
    }

    private var mergePresented: Binding<Bool> {
        Binding(get: { mergePlan != nil }, set: { if !$0 { mergePlan = nil } })
    }
}

private struct MergeCandidates: Identifiable {
    let id = UUID()
    let people: [PersonDTO]
}

private struct MergePlan {
    let target: PersonDTO
    let sources: [PersonDTO]
}

/// Merge step two: which of the selected people to keep.
private struct MergeTargetPicker: View {
    let candidates: [PersonDTO]
    let apiBaseURL: URL
    let choose: (PersonDTO) -> Void
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            List {
                Section {
                    ForEach(candidates) { person in
                        Button {
                            choose(person)
                        } label: {
                            PersonRow(person: person, apiBaseURL: apiBaseURL, isCurrent: false)
                        }
                        .buttonStyle(.plain)
                    }
                } footer: {
                    Text("The others’ faces move to the person you keep.")
                }
            }
            .navigationTitle("Keep Which Person?")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                }
            }
        }
    }
}

/// A list row: avatar, name (or "Add a name"), and photo count, with a checkmark when current.
private struct PersonRow: View {
    let person: PersonDTO
    let apiBaseURL: URL
    let isCurrent: Bool

    var body: some View {
        HStack(spacing: 12) {
            FaceCropImage(faceID: person.coverFaceId, apiBaseURL: apiBaseURL, name: person.name)
                .frame(width: 40, height: 40)
            VStack(alignment: .leading, spacing: 2) {
                Text(PersonLabel.displayName(person))
                    .foregroundStyle(person.name == nil ? .secondary : .primary)
                Text(PersonLabel.photoCountText(person.photoCount))
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            .lineLimit(1)
            Spacer(minLength: 8)
            if isCurrent {
                Image(systemName: "checkmark")
                    .foregroundStyle(.tint)
            }
        }
        .contentShape(Rectangle())
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(PersonLabel.accessibilityLabel(person))
        .accessibilityAddTraits(isCurrent ? [.isButton, .isSelected] : .isButton)
    }
}

/// One person's photos with the same grid and loupe as a collection, listed through the
/// `personId` filter. The title is the person's live name; the toolbar renames them.
struct PersonDetailScreen: View {
    let person: PersonDTO
    @ObservedObject var people: PeopleStore
    let collections: CollectionsStore
    let api: any PhotoBrainAPI
    @StateObject private var store: LibraryStore
    @State private var renamePresented = false
    @State private var renameText = ""

    init(
        person: PersonDTO,
        people: PeopleStore,
        collections: CollectionsStore,
        curation: PhotoCurationCenter,
        api: any PhotoBrainAPI
    ) {
        self.person = person
        self.people = people
        self.collections = collections
        self.api = api
        _store = StateObject(
            wrappedValue: LibraryStore(api: api, curation: curation, scope: .person(person.id))
        )
    }

    private var current: PersonDTO {
        people.person(id: person.id) ?? person
    }

    var body: some View {
        ScopedPhotoGrid(
            store: store,
            collections: collections,
            api: api,
            title: PersonLabel.displayName(current),
            noun: "Person",
            emptyTitle: "No Photos",
            emptyDescription: "No photos of this person are in the library.",
            onRefresh: { await people.load() }
        )
        .safeAreaInset(edge: .top, spacing: 0) {
            if let message = people.errorMessage {
                ErrorBanner(message: message, dismiss: { people.dismissError() })
            }
        }
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Button {
                    renameText = current.name ?? ""
                    renamePresented = true
                } label: {
                    Label(current.name == nil ? "Add Name" : "Rename", systemImage: "pencil")
                }
            }
        }
        .alert(current.name == nil ? "Add a Name" : "Rename Person", isPresented: $renamePresented) {
            TextField("Name", text: $renameText)
            Button("Cancel", role: .cancel) {}
            Button("Save") {
                let name = renameText
                Task { await people.rename(id: person.id, to: name) }
            }
        } message: {
            Text("Leave the name blank to remove it.")
        }
    }
}

/// Info-sheet People section: the photo's faces left to right as crop avatars. Tapping one
/// opens the assign sheet.
struct PhotoFacesSection: View {
    @ObservedObject var faces: PhotoFacesStore
    let apiBaseURL: URL
    let onSelect: (PhotoFaceDTO) -> Void

    var body: some View {
        if let message = faces.errorMessage {
            HStack(spacing: 8) {
                Image(systemName: "exclamationmark.triangle.fill")
                    .foregroundStyle(.orange)
                Text("Couldn’t update. \(message)")
                    .font(.caption)
                Spacer(minLength: 4)
                Button {
                    faces.dismissError()
                } label: {
                    Image(systemName: "xmark")
                }
                .buttonStyle(.borderless)
                .accessibilityLabel("Dismiss error")
            }
        }
        switch faces.state {
        case .loading:
            HStack(spacing: 8) {
                ProgressView()
                Text("Loading faces…").foregroundStyle(.secondary)
            }
        case let .failed(message):
            VStack(alignment: .leading, spacing: 6) {
                Text("Faces are unavailable.")
                Text(message).font(.caption).foregroundStyle(.secondary)
                Button("Try Again") { Task { await faces.load() } }
            }
        case let .loaded(list) where list.isEmpty:
            Text("No faces found").foregroundStyle(.secondary)
        case let .loaded(list):
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(alignment: .top, spacing: 14) {
                    ForEach(Array(list.enumerated()), id: \.element.id) { index, face in
                        faceButton(face, index: index, count: list.count)
                    }
                }
                .padding(.vertical, 4)
            }
        }
    }

    private func faceButton(_ face: PhotoFaceDTO, index: Int, count: Int) -> some View {
        Button {
            onSelect(face)
        } label: {
            VStack(spacing: 4) {
                FaceCropImage(faceID: face.id, apiBaseURL: apiBaseURL, name: face.personName)
                    .frame(width: 56, height: 56)
                Text(PersonLabel.faceTitle(face))
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(face.personName == nil ? .secondary : .primary)
                if let detail = PersonLabel.faceDetail(face) {
                    Text(detail)
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                }
            }
            .lineLimit(1)
            .frame(width: 76)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .disabled(faces.pendingFaceIDs.contains(face.id))
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(PersonLabel.faceAccessibilityLabel(face, index: index, count: count))
        .accessibilityHint("Choose who this is")
        .accessibilityAddTraits(.isButton)
    }
}

/// Chooses who a face is: an existing person (searchable), a new named person, or nobody
/// ("Not This Person"). The choice is handed back and the sheet closes at once; the caller
/// applies it optimistically.
struct FaceAssignSheet: View {
    let face: PhotoFaceDTO
    let apiBaseURL: URL
    /// `displayName` is the chosen person's name, shown until the server confirms.
    let assign: (FaceAssignmentTarget, _ displayName: String?) -> Void
    @StateObject private var people: PeopleStore
    @Environment(\.dismiss) private var dismiss
    @State private var search = ""
    @State private var newPersonPresented = false
    @State private var newName = ""

    /// Uses the app's shared people list when there is one, otherwise loads its own.
    init(
        face: PhotoFaceDTO,
        api: any PhotoBrainAPI,
        people: PeopleStore?,
        assign: @escaping (FaceAssignmentTarget, _ displayName: String?) -> Void
    ) {
        self.face = face
        apiBaseURL = api.baseURL
        self.assign = assign
        _people = StateObject(wrappedValue: people ?? PeopleStore(api: api))
    }

    var body: some View {
        NavigationStack {
            List {
                Section {
                    HStack(spacing: 12) {
                        FaceCropImage(faceID: face.id, apiBaseURL: apiBaseURL, name: face.personName)
                            .frame(width: 64, height: 64)
                        VStack(alignment: .leading, spacing: 2) {
                            Text(PersonLabel.faceTitle(face))
                                .font(.headline)
                            if let detail = PersonLabel.faceDetail(face) {
                                Text(detail)
                                    .font(.subheadline)
                                    .foregroundStyle(.secondary)
                            }
                        }
                    }
                    .accessibilityElement(children: .combine)
                }
                Section {
                    Button {
                        newName = search.trimmingCharacters(in: .whitespacesAndNewlines)
                        newPersonPresented = true
                    } label: {
                        Label("New Person…", systemImage: "person.badge.plus")
                    }
                    if face.assignment != .rejected {
                        Button(role: .destructive) {
                            choose(.notThisPerson, displayName: nil)
                        } label: {
                            Label("Not This Person", systemImage: "person.crop.circle.badge.xmark")
                        }
                    }
                }
                Section("People") {
                    peopleContent
                }
            }
            .searchable(
                text: $search,
                placement: .navigationBarDrawer(displayMode: .always),
                prompt: "Search People"
            )
            .navigationTitle("Who Is This?")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                }
            }
            .task { await people.loadIfNeeded() }
            .alert("New Person", isPresented: $newPersonPresented) {
                TextField("Name", text: $newName)
                Button("Cancel", role: .cancel) {}
                Button("Create") {
                    choose(.newPerson(name: newName), displayName: nil)
                }
            } message: {
                Text("Enter a name for this person.")
            }
        }
    }

    @ViewBuilder
    private var peopleContent: some View {
        switch people.loadState {
        case .idle, .loading:
            HStack(spacing: 8) {
                ProgressView()
                Text("Loading people…").foregroundStyle(.secondary)
            }
        case let .failed(message):
            VStack(alignment: .leading, spacing: 6) {
                Text("People are unavailable.")
                Text(message).font(.caption).foregroundStyle(.secondary)
                Button("Try Again") { Task { await people.load() } }
            }
        case .loaded:
            let matches = people.matching(search)
            if matches.isEmpty {
                Text(search.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                    ? "No people yet"
                    : "No people match “\(search)”")
                    .foregroundStyle(.secondary)
            } else {
                ForEach(matches) { person in
                    Button {
                        choose(.person(person.id), displayName: person.name)
                    } label: {
                        PersonRow(person: person, apiBaseURL: apiBaseURL, isCurrent: person.id == face.personId)
                    }
                    .buttonStyle(.plain)
                }
            }
        }
    }

    private func choose(_ target: FaceAssignmentTarget, displayName: String?) {
        assign(target, displayName)
        dismiss()
    }
}
