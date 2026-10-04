import SwiftUI

/// Collections tab: People avatars, a two-column grid of collection cards, then auto Events
/// and Smart Albums sections, with create, rename, and delete for collections and
/// rename/delete for smart albums.
struct CollectionsScreen: View {
    @ObservedObject var store: CollectionsStore
    @ObservedObject var smartAlbums: SmartAlbumsStore
    @ObservedObject var events: EventsStore
    @ObservedObject var people: PeopleStore
    let curation: PhotoCurationCenter
    let environment: AppEnvironment
    @ObservedObject var theme: ThemeController

    @State private var newNamePresented = false
    @State private var newName = ""
    @State private var renameTarget: CollectionDTO?
    @State private var renameText = ""
    @State private var deleteTarget: CollectionDTO?
    @State private var albumRenameTarget: SmartAlbumDTO?
    @State private var albumRenameText = ""
    @State private var albumDeleteTarget: SmartAlbumDTO?

    private let columns = [
        GridItem(.flexible(), spacing: 14),
        GridItem(.flexible(), spacing: 14),
    ]

    var body: some View {
        NavigationStack {
            content
                .navigationTitle("Collections")
                .safeAreaInset(edge: .top, spacing: 0) {
                    if let message = store.errorMessage {
                        ErrorBanner(message: message, dismiss: { store.dismissError() })
                    } else if let message = smartAlbums.errorMessage {
                        ErrorBanner(message: message, dismiss: { smartAlbums.dismissError() })
                    } else if let message = events.errorMessage {
                        ErrorBanner(message: message, dismiss: { events.dismissError() })
                    } else if let message = people.errorMessage {
                        ErrorBanner(message: message, dismiss: { people.dismissError() })
                    }
                }
                .toolbar {
                    ToolbarItem(placement: .topBarLeading) {
                        NavigationLink {
                            SettingsView(environment: environment, theme: theme)
                        } label: {
                            Image(systemName: "gearshape")
                        }
                        .accessibilityLabel("Settings")
                    }
                    ToolbarItem(placement: .topBarTrailing) {
                        Button {
                            presentNewCollection()
                        } label: {
                            Image(systemName: "plus")
                        }
                        .accessibilityLabel("New Collection")
                    }
                }
                .navigationDestination(for: CollectionRoute.self) { route in
                    CollectionDetailScreen(
                        collection: route.collection,
                        collections: store,
                        curation: curation,
                        api: environment.api
                    )
                }
                .navigationDestination(for: SmartAlbumRoute.self) { route in
                    SmartAlbumDetailScreen(
                        album: route.album,
                        smartAlbums: smartAlbums,
                        collections: store,
                        curation: curation,
                        api: environment.api
                    )
                }
                .navigationDestination(for: EventRoute.self) { route in
                    EventDetailScreen(
                        card: route.card,
                        events: events,
                        collections: store,
                        curation: curation,
                        api: environment.api
                    )
                }
                .navigationDestination(for: PeopleListRoute.self) { _ in
                    PeopleScreen(store: people, apiBaseURL: environment.api.baseURL)
                }
                .navigationDestination(for: PersonRoute.self) { route in
                    PersonDetailScreen(
                        person: route.person,
                        people: people,
                        collections: store,
                        curation: curation,
                        api: environment.api
                    )
                }
        }
        .task { await store.loadIfNeeded() }
        .task { await people.loadIfNeeded() }
        .task { await smartAlbums.loadIfNeeded() }
        .task { await events.loadIfNeeded() }
        .alert("New Collection", isPresented: $newNamePresented) {
            TextField("Name", text: $newName)
            Button("Cancel", role: .cancel) {}
            Button("Create") {
                let name = newName
                Task { await store.create(name: name) }
            }
        } message: {
            Text("Enter a name for this collection.")
        }
        .alert("Rename Collection", isPresented: renamePresented, presenting: renameTarget) { target in
            TextField("Name", text: $renameText)
            Button("Cancel", role: .cancel) {}
            Button("Rename") {
                let name = renameText
                Task { await store.rename(id: target.id, to: name) }
            }
        }
        .confirmationDialog(
            deleteTarget.map { "Delete “\($0.name)”?" } ?? "Delete Collection?",
            isPresented: deletePresented,
            titleVisibility: .visible,
            presenting: deleteTarget
        ) { target in
            Button("Delete Collection", role: .destructive) {
                Task { await store.delete(id: target.id) }
            }
            Button("Cancel", role: .cancel) {}
        } message: { _ in
            Text("The photos stay in your library.")
        }
        .alert("Rename Smart Album", isPresented: albumRenamePresented, presenting: albumRenameTarget) { target in
            TextField("Name", text: $albumRenameText)
            Button("Cancel", role: .cancel) {}
            Button("Rename") {
                let name = albumRenameText
                Task { await smartAlbums.rename(id: target.id, to: name) }
            }
        }
        .confirmationDialog(
            albumDeleteTarget.map { "Delete “\($0.name)”?" } ?? "Delete Smart Album?",
            isPresented: albumDeletePresented,
            titleVisibility: .visible,
            presenting: albumDeleteTarget
        ) { target in
            Button("Delete Smart Album", role: .destructive) {
                Task { await smartAlbums.delete(id: target.id) }
            }
            Button("Cancel", role: .cancel) {}
        } message: { _ in
            Text("Only the saved search is deleted. The photos stay in your library.")
        }
    }

    @ViewBuilder
    private var content: some View {
        switch store.loadState {
        case .idle, .loading:
            ProgressView("Loading Collections…")
                .frame(maxWidth: .infinity, maxHeight: .infinity)
        case let .failed(message):
            ContentUnavailableView {
                Label("Collections Unavailable", systemImage: "wifi.exclamationmark")
            } description: {
                Text(message)
            } actions: {
                Button("Try Again") { Task { await store.load() } }
                    .buttonStyle(.borderedProminent)
            }
        case .loaded:
            ScrollView {
                VStack(alignment: .leading, spacing: 18) {
                    PeopleSection(store: people, apiBaseURL: environment.api.baseURL) {
                        sectionHeader("People")
                    }
                    if store.collections.isEmpty {
                        ContentUnavailableView {
                            Label("No Collections", systemImage: "rectangle.stack")
                        } description: {
                            Text("Group photos into named collections. Deleting a collection never deletes its photos.")
                        } actions: {
                            Button("New Collection") { presentNewCollection() }
                                .buttonStyle(.borderedProminent)
                        }
                        .padding(.top, 60)
                    } else {
                        LazyVGrid(columns: columns, spacing: 18) {
                            ForEach(store.collections) { collection in
                                NavigationLink(value: CollectionRoute(collection: collection)) {
                                    CollectionCard(collection: collection, apiBaseURL: environment.api.baseURL)
                                }
                                .buttonStyle(.plain)
                                .contextMenu {
                                    Button {
                                        renameText = collection.name
                                        renameTarget = collection
                                    } label: {
                                        Label("Rename", systemImage: "pencil")
                                    }
                                    Button(role: .destructive) {
                                        deleteTarget = collection
                                    } label: {
                                        Label("Delete", systemImage: "trash")
                                    }
                                }
                            }
                        }
                    }
                    EventsSection(store: events, apiBaseURL: environment.api.baseURL) {
                        sectionHeader("Events")
                    }
                    smartAlbumsSection
                }
                .padding(16)
            }
            .refreshable {
                async let collections: Void = store.load()
                async let albums: Void = smartAlbums.load()
                async let eventList: Void = events.load()
                async let peopleList: Void = people.load()
                _ = await (collections, albums, eventList, peopleList)
            }
        }
    }

    /// Hidden until the list loads with at least one album, unless the first load failed.
    @ViewBuilder
    private var smartAlbumsSection: some View {
        switch smartAlbums.loadState {
        case .idle, .loading:
            EmptyView()
        case let .failed(message):
            VStack(alignment: .leading, spacing: 8) {
                sectionHeader("Smart Albums")
                ErrorBanner(message: message, retry: { Task { await smartAlbums.load() } })
                    .clipShape(RoundedRectangle(cornerRadius: 8))
            }
        case .loaded where smartAlbums.albums.isEmpty:
            EmptyView()
        case .loaded:
            VStack(alignment: .leading, spacing: 10) {
                sectionHeader("Smart Albums")
                LazyVGrid(columns: columns, spacing: 18) {
                    ForEach(smartAlbums.albums) { album in
                        NavigationLink(value: SmartAlbumRoute(album: album)) {
                            SmartAlbumCard(album: album, apiBaseURL: environment.api.baseURL)
                        }
                        .buttonStyle(.plain)
                        .contextMenu {
                            Button {
                                albumRenameText = album.name
                                albumRenameTarget = album
                            } label: {
                                Label("Rename", systemImage: "pencil")
                            }
                            Button(role: .destructive) {
                                albumDeleteTarget = album
                            } label: {
                                Label("Delete", systemImage: "trash")
                            }
                        }
                    }
                }
            }
        }
    }

    private func sectionHeader(_ title: String) -> some View {
        Text(title)
            .font(.title3.weight(.semibold))
            .accessibilityAddTraits(.isHeader)
    }

    private func presentNewCollection() {
        newName = ""
        newNamePresented = true
    }

    private var renamePresented: Binding<Bool> {
        Binding(get: { renameTarget != nil }, set: { if !$0 { renameTarget = nil } })
    }

    private var deletePresented: Binding<Bool> {
        Binding(get: { deleteTarget != nil }, set: { if !$0 { deleteTarget = nil } })
    }

    private var albumRenamePresented: Binding<Bool> {
        Binding(get: { albumRenameTarget != nil }, set: { if !$0 { albumRenameTarget = nil } })
    }

    private var albumDeletePresented: Binding<Bool> {
        Binding(get: { albumDeleteTarget != nil }, set: { if !$0 { albumDeleteTarget = nil } })
    }
}

/// Navigation value for a collection; detail screens read the live name from the store.
struct CollectionRoute: Hashable {
    let collection: CollectionDTO

    static func == (lhs: Self, rhs: Self) -> Bool { lhs.collection.id == rhs.collection.id }
    func hash(into hasher: inout Hasher) { hasher.combine(collection.id) }
}

private struct CollectionCard: View {
    let collection: CollectionDTO
    let apiBaseURL: URL

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Color(uiColor: .secondarySystemBackground)
                .aspectRatio(1, contentMode: .fit)
                .overlay {
                    if let cover = collection.cover, let url = collection.coverURL(apiBaseURL: apiBaseURL) {
                        CollectionCoverImage(photoID: cover.photoId, url: url)
                    } else {
                        Image(systemName: "rectangle.stack")
                            .font(.largeTitle)
                            .foregroundStyle(.secondary)
                    }
                }
                .clipShape(RoundedRectangle(cornerRadius: 10))
            Text(collection.name)
                .font(.subheadline.weight(.semibold))
                .lineLimit(1)
            Text(collection.photoCount == 1 ? "1 Photo" : "\(collection.photoCount.formatted()) Photos")
                .font(.caption)
                .foregroundStyle(.secondary)
        }
        .contentShape(Rectangle())
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("\(collection.name), \(collection.photoCount) photos")
        .accessibilityAddTraits(.isButton)
    }
}

struct CollectionCoverImage: View {
    let photoID: Int
    let url: URL
    @State private var image: UIImage?

    var body: some View {
        GeometryReader { geometry in
            Group {
                if let image {
                    Image(uiImage: image)
                        .resizable()
                        .aspectRatio(contentMode: .fill)
                } else {
                    Color(uiColor: SyntheticThumbnail.color(id: photoID))
                }
            }
            .frame(width: geometry.size.width, height: geometry.size.height)
            .clipped()
            .task(id: url) {
                image = nil
                image = try? await RedirectAwareImageLoader().image(
                    photoID: photoID,
                    url: url,
                    isConvertedRAW: false,
                    targetSize: geometry.size
                )
            }
        }
        .accessibilityHidden(true)
    }
}

/// One collection's photos, with the same grid and loupe as the Library, and a ZIP export.
struct CollectionDetailScreen: View {
    let collection: CollectionDTO
    @ObservedObject var collections: CollectionsStore
    let api: any PhotoBrainAPI
    @StateObject private var store: LibraryStore
    @StateObject private var exports: ExportStore

    init(
        collection: CollectionDTO,
        collections: CollectionsStore,
        curation: PhotoCurationCenter,
        api: any PhotoBrainAPI
    ) {
        self.collection = collection
        self.collections = collections
        self.api = api
        _store = StateObject(
            wrappedValue: LibraryStore(api: api, curation: curation, scope: .collection(collection.id))
        )
        _exports = StateObject(wrappedValue: ExportStore(api: api))
    }

    private var title: String {
        collections.collection(id: collection.id)?.name ?? collection.name
    }

    var body: some View {
        ScopedPhotoGrid(
            store: store,
            collections: collections,
            api: api,
            title: title,
            noun: "Collection",
            emptyTitle: "No Photos",
            emptyDescription: "Add photos from the Library with Add to Collection.",
            onRefresh: { await collections.load() }
        )
        .safeAreaInset(edge: .top, spacing: 0) {
            if case let .failed(failure) = exports.state {
                ErrorBanner(
                    message: "Couldn’t export. \(failure.message)",
                    retry: failure.retryTarget.map { _ in { exports.retry() } },
                    dismiss: exports.dismissError
                )
            }
        }
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                exportMenu
            }
        }
        .exportPresentation(exports)
        .task { collections.register(store) }
    }

    private var exportMenu: some View {
        Menu {
            Button("Originals (ZIP)") {
                exports.start(.collection(id: collection.id, size: .original))
            }
            Button("JPEGs, 2048 px (ZIP)") {
                exports.start(.collection(id: collection.id, size: .jpeg2048))
            }
        } label: {
            Label("Export", systemImage: "square.and.arrow.up")
        }
        .disabled(exports.isBusy || store.loadState == .empty)
    }
}

/// Grid, refresh error, empty/failed states, and loupe for a scoped `LibraryStore`
/// (a collection, a smart album, or an event). Loads the store the first time it appears.
struct ScopedPhotoGrid: View {
    @ObservedObject var store: LibraryStore
    let collections: CollectionsStore
    let api: any PhotoBrainAPI
    let title: String
    /// Used in loading/failure titles, e.g. "Collection".
    let noun: String
    let emptyTitle: String
    let emptyDescription: String
    /// Extra work after a pull-to-refresh reload, e.g. refreshing card counts.
    let onRefresh: () async -> Void

    var body: some View {
        VStack(spacing: 0) {
            if let error = store.refreshError {
                ErrorBanner(message: "Couldn’t refresh. \(error)", retry: { Task { await store.load() } })
            }
            content
        }
        .navigationTitle(title)
        .navigationBarTitleDisplayMode(.inline)
        .task {
            if store.loadState == .idle { await store.load() }
        }
        .fullScreenCover(isPresented: loupePresented) {
            if let activeID = store.activePhotoID {
                LoupeScreen(
                    records: store.orderedRecords,
                    activeID: Binding(
                        get: { store.activePhotoID ?? activeID },
                        set: { store.activePhotoID = $0 }
                    ),
                    api: api,
                    curation: store.curation,
                    collections: collections,
                    dismiss: { store.activePhotoID = nil }
                )
            }
        }
    }

    @ViewBuilder
    private var content: some View {
        switch store.loadState {
        case .idle, .loading:
            ProgressView("Loading \(noun)…")
                .frame(maxWidth: .infinity, maxHeight: .infinity)
        case let .failed(message):
            ContentUnavailableView {
                Label("\(noun) Unavailable", systemImage: "wifi.exclamationmark")
            } description: {
                Text(message)
            } actions: {
                Button("Try Again") { Task { await store.load() } }
                    .buttonStyle(.borderedProminent)
            }
        case .empty:
            ContentUnavailableView(
                emptyTitle,
                systemImage: "rectangle.stack",
                description: Text(emptyDescription)
            )
        case .content:
            LibraryGrid(
                sections: store.sections,
                selectedID: $store.activePhotoID,
                selectedIDs: $store.selectedPhotoIDs,
                isSelecting: false,
                resetVersion: store.browsingResetVersion,
                contentRevision: store.presentationRevision,
                onLongPress: { _ in },
                onVisibleChange: store.observeVisible,
                onRefresh: {
                    await store.load()
                    await onRefresh()
                }
            )
            .ignoresSafeArea(edges: .horizontal)
        }
    }

    private var loupePresented: Binding<Bool> {
        Binding(
            get: { store.activePhotoID != nil },
            set: { if !$0 { store.activePhotoID = nil } }
        )
    }
}

/// Inline error with an optional Retry and/or dismiss control.
struct ErrorBanner: View {
    let message: String
    var retry: (() -> Void)?
    var dismiss: (() -> Void)?

    var body: some View {
        HStack(spacing: 8) {
            Image(systemName: "exclamationmark.triangle.fill")
            Text(message)
                .lineLimit(3)
            Spacer(minLength: 4)
            if let retry {
                Button("Retry", action: retry)
            }
            if let dismiss {
                Button(action: dismiss) {
                    Image(systemName: "xmark")
                        .frame(width: 32, height: 32)
                }
                .accessibilityLabel("Dismiss error")
            }
        }
        .font(.caption)
        .padding(.horizontal, 12)
        .padding(.vertical, 6)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color.orange.opacity(0.85))
    }
}

/// Loupe sheet: a checklist of every collection for one photo; toggles apply immediately.
struct AddToCollectionSheet: View {
    @ObservedObject var collections: CollectionsStore
    @StateObject private var membership: CollectionMembershipStore
    @Environment(\.dismiss) private var dismiss
    @State private var newNamePresented = false
    @State private var newName = ""

    init(photoID: Int, collections: CollectionsStore) {
        self.collections = collections
        _membership = StateObject(
            wrappedValue: CollectionMembershipStore(photoID: photoID, collections: collections)
        )
    }

    var body: some View {
        NavigationStack {
            content
                .navigationTitle("Add to Collection")
                .navigationBarTitleDisplayMode(.inline)
                .safeAreaInset(edge: .top, spacing: 0) {
                    if let message = membership.errorMessage {
                        ErrorBanner(message: message, dismiss: { membership.dismissError() })
                    }
                }
                .toolbar {
                    ToolbarItem(placement: .confirmationAction) {
                        Button("Done") { dismiss() }
                    }
                }
        }
        .presentationDetents([.medium, .large])
        .task { await membership.load() }
        .alert("New Collection", isPresented: $newNamePresented) {
            TextField("Name", text: $newName)
            Button("Cancel", role: .cancel) {}
            Button("Create") {
                let name = newName
                Task { await membership.createCollection(named: name) }
            }
        } message: {
            Text("The photo is added to the new collection.")
        }
    }

    @ViewBuilder
    private var content: some View {
        switch membership.state {
        case .loading:
            ProgressView()
                .frame(maxWidth: .infinity, maxHeight: .infinity)
        case let .failed(message):
            ContentUnavailableView {
                Label("Collections Unavailable", systemImage: "wifi.exclamationmark")
            } description: {
                Text(message)
            } actions: {
                Button("Try Again") { Task { await membership.load() } }
                    .buttonStyle(.borderedProminent)
            }
        case .loaded:
            List {
                Section {
                    Button {
                        newName = ""
                        newNamePresented = true
                    } label: {
                        Label("New Collection…", systemImage: "plus")
                    }
                }
                if !collections.collections.isEmpty {
                    Section("Collections") {
                        ForEach(collections.collections) { collection in
                            membershipRow(collection)
                        }
                    }
                }
            }
        }
    }

    private func membershipRow(_ collection: CollectionDTO) -> some View {
        let isMember = membership.isMember(collection.id)
        return Button {
            membership.toggle(collection.id)
        } label: {
            HStack {
                VStack(alignment: .leading, spacing: 2) {
                    Text(collection.name)
                        .foregroundStyle(.primary)
                    Text(collection.photoCount == 1 ? "1 Photo" : "\(collection.photoCount.formatted()) Photos")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
                Spacer()
                if membership.inFlightIDs.contains(collection.id) {
                    ProgressView()
                } else {
                    Image(systemName: isMember ? "checkmark.circle.fill" : "circle")
                        .foregroundStyle(isMember ? Color.accentColor : Color.secondary)
                        .font(.title3)
                }
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .disabled(membership.inFlightIDs.contains(collection.id))
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(collection.name)
        .accessibilityValue(isMember ? "In collection" : "Not in collection")
        .accessibilityAddTraits(isMember ? [.isButton, .isSelected] : .isButton)
    }
}

/// Library selection action: adds every selected photo to one collection or a new one.
struct AddSelectionToCollectionSheet: View {
    let photoIDs: [Int]
    @ObservedObject var collections: CollectionsStore
    let completed: () -> Void
    @Environment(\.dismiss) private var dismiss
    @State private var newNamePresented = false
    @State private var newName = ""
    @State private var isSaving = false
    @State private var errorMessage: String?

    var body: some View {
        NavigationStack {
            List {
                Section {
                    Button {
                        newName = ""
                        newNamePresented = true
                    } label: {
                        Label("New Collection…", systemImage: "plus")
                    }
                }
                if !collections.collections.isEmpty {
                    Section("Collections") {
                        ForEach(collections.collections) { collection in
                            Button {
                                Task {
                                    await save {
                                        try await collections.setMembership(
                                            photoIDs,
                                            collectionId: collection.id,
                                            isMember: true
                                        )
                                    }
                                }
                            } label: {
                                LabeledContent(
                                    collection.name,
                                    value: collection.photoCount == 1
                                        ? "1 Photo" : "\(collection.photoCount.formatted()) Photos"
                                )
                            }
                            .foregroundStyle(.primary)
                        }
                    }
                }
            }
            .disabled(isSaving)
            .overlay { if isSaving { ProgressView() } }
            .navigationTitle(photoIDs.count == 1 ? "Add 1 Photo" : "Add \(photoIDs.count) Photos")
            .navigationBarTitleDisplayMode(.inline)
            .safeAreaInset(edge: .top, spacing: 0) {
                if let errorMessage {
                    ErrorBanner(message: errorMessage, dismiss: { self.errorMessage = nil })
                }
            }
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                }
            }
        }
        .presentationDetents([.medium, .large])
        .task { await collections.loadIfNeeded() }
        .alert("New Collection", isPresented: $newNamePresented) {
            TextField("Name", text: $newName)
            Button("Cancel", role: .cancel) {}
            Button("Create") {
                let name = newName
                Task {
                    await save { _ = try await collections.createCollection(name: name, photoIds: photoIDs) }
                }
            }
        }
    }

    private func save(_ operation: () async throws -> Void) async {
        isSaving = true
        errorMessage = nil
        defer { isSaving = false }
        do {
            try await operation()
            completed()
            dismiss()
        } catch is CancellationError {
            return
        } catch {
            errorMessage = CollectionsStore.message(for: error)
        }
    }
}
