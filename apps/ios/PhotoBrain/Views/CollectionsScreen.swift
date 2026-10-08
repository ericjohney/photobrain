import SwiftUI

/// Albums tab: Memories (auto events and On this day), People avatars, My Albums and Smart
/// Albums as horizontal tile rows, then the Library utilities (Review, Duplicates, Map, Gear
/// Stats). Collections support create, rename, and delete; smart albums rename and delete.
struct CollectionsScreen: View {
    @ObservedObject var store: CollectionsStore
    @ObservedObject var smartAlbums: SmartAlbumsStore
    @ObservedObject var events: EventsStore
    @ObservedObject var people: PeopleStore
    @ObservedObject var onThisDay: OnThisDayStore
    @ObservedObject var review: ReviewStore
    @ObservedObject var duplicates: DuplicatesStore
    let curation: PhotoCurationCenter
    let environment: AppEnvironment
    @ObservedObject var theme: ThemeController
    /// Opens a Library utility screen on the Library tab.
    let openUtility: (LibraryUtility) -> Void
    /// Opens Gear Stats over the current Library filters.
    let openGearStats: () -> Void
    @Environment(\.showInLibrary) private var showInLibrary

    @State private var newNamePresented = false
    @State private var newName = ""
    @State private var renameTarget: CollectionDTO?
    @State private var renameText = ""
    @State private var deleteTarget: CollectionDTO?
    @State private var albumRenameTarget: SmartAlbumDTO?
    @State private var albumRenameText = ""
    @State private var albumDeleteTarget: SmartAlbumDTO?

    var body: some View {
        NavigationStack {
            content
                .navigationTitle("Albums")
                .safeAreaInset(edge: .top, spacing: 0) {
                    if let message = store.errorMessage {
                        PBBanner(message: message, dismiss: { store.dismissError() })
                    } else if let message = smartAlbums.errorMessage {
                        PBBanner(message: message, dismiss: { smartAlbums.dismissError() })
                    } else if let message = events.errorMessage {
                        PBBanner(message: message, dismiss: { events.dismissError() })
                    } else if let message = people.errorMessage {
                        PBBanner(message: message, dismiss: { people.dismissError() })
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
        .task { if onThisDay.state == .idle { await onThisDay.load() } }
        .task { await review.refreshCounts() }
        .task { await duplicates.refreshCounts() }
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
                VStack(alignment: .leading, spacing: PBSpacing.xl) {
                    MemoriesSection(
                        events: events,
                        onThisDay: onThisDay,
                        apiBaseURL: environment.api.baseURL,
                        selectDate: { showInLibrary?(.capturedDate($0)) }
                    )
                    PeopleSection(store: people, apiBaseURL: environment.api.baseURL) {
                        PBSectionHeader(title: "People")
                    }
                    myAlbumsSection
                    smartAlbumsSection
                    utilitiesSection
                }
                .padding(.vertical, PBSpacing.l)
            }
            .background(Color(uiColor: .systemGroupedBackground))
            .refreshable {
                async let collections: Void = store.load()
                async let albums: Void = smartAlbums.load()
                async let eventList: Void = events.load()
                async let peopleList: Void = people.load()
                async let days: Void = onThisDay.load()
                _ = await (collections, albums, eventList, peopleList, days)
                await review.refreshCounts()
                await duplicates.refreshCounts()
            }
        }
    }

    @ViewBuilder
    private var myAlbumsSection: some View {
        VStack(alignment: .leading, spacing: PBSpacing.m) {
            PBSectionHeader(title: "My Albums")
                .padding(.horizontal, PBSpacing.l)
            if store.collections.isEmpty {
                Button {
                    presentNewCollection()
                } label: {
                    HStack(spacing: PBSpacing.m) {
                        Image(systemName: "rectangle.stack.badge.plus")
                            .font(.title2)
                            .foregroundStyle(PBColor.accent)
                        VStack(alignment: .leading, spacing: 2) {
                            Text("Create an album").font(.subheadline.weight(.semibold))
                            Text("Deleting an album never deletes its photos.")
                                .font(.caption)
                                .foregroundStyle(.secondary)
                        }
                        Spacer()
                    }
                    .padding(PBSpacing.m)
                    .background(
                        RoundedRectangle(cornerRadius: PBRadius.card, style: .continuous)
                            .fill(Color(uiColor: .secondarySystemGroupedBackground))
                    )
                }
                .buttonStyle(.plain)
                .padding(.horizontal, PBSpacing.l)
            } else {
                ScrollView(.horizontal, showsIndicators: false) {
                    LazyHStack(alignment: .top, spacing: PBSpacing.m) {
                        ForEach(store.collections) { collection in
                            NavigationLink(value: CollectionRoute(collection: collection)) {
                                CollectionCard(collection: collection, apiBaseURL: environment.api.baseURL)
                                    .frame(width: PBSize.albumTile)
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
                    .padding(.horizontal, PBSpacing.l)
                }
            }
        }
    }

    /// Review, Duplicates, Map, and Gear Stats as an inset grouped list with counts.
    private var utilitiesSection: some View {
        VStack(alignment: .leading, spacing: PBSpacing.m) {
            PBSectionHeader(title: "Utilities")
                .padding(.horizontal, PBSpacing.l)
            VStack(spacing: 0) {
                utilityRow("Review", systemImage: "sparkles.rectangle.stack", count: review.counts.all,
                           accessibility: "Review, \(CountText.photos(review.counts.all))") {
                    openUtility(.review)
                }
                Divider().padding(.leading, 52)
                utilityRow("Duplicates", systemImage: "square.on.square", count: duplicates.counts.total,
                           accessibility: "Duplicates, \(CountText.of(duplicates.counts.total, "group", "groups"))") {
                    openUtility(.duplicates)
                }
                Divider().padding(.leading, 52)
                utilityRow("Map", systemImage: "map", count: nil, accessibility: "Map") {
                    openUtility(.map)
                }
                Divider().padding(.leading, 52)
                utilityRow("Gear Stats", systemImage: "chart.bar", count: nil, accessibility: "Gear Stats", action: openGearStats)
            }
            .background(
                RoundedRectangle(cornerRadius: PBRadius.card, style: .continuous)
                    .fill(Color(uiColor: .secondarySystemGroupedBackground))
            )
            .padding(.horizontal, PBSpacing.l)
        }
    }

    private func utilityRow(
        _ title: String,
        systemImage: String,
        count: Int?,
        accessibility: String,
        action: @escaping () -> Void
    ) -> some View {
        Button(action: action) {
            HStack(spacing: PBSpacing.m) {
                Image(systemName: systemImage)
                    .font(.body.weight(.medium))
                    .foregroundStyle(PBColor.accent)
                    .frame(width: 28)
                Text(title)
                    .foregroundStyle(.primary)
                Spacer()
                if let count, count > 0 {
                    Text(count.formatted())
                        .monospacedDigit()
                        .foregroundStyle(.secondary)
                }
                Image(systemName: "chevron.right")
                    .font(.footnote.weight(.semibold))
                    .foregroundStyle(.tertiary)
            }
            .padding(.horizontal, PBSpacing.m)
            .frame(minHeight: PBSize.control + 4)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel(accessibility)
    }

    /// Hidden until the list loads with at least one album, unless the first load failed.
    @ViewBuilder
    private var smartAlbumsSection: some View {
        switch smartAlbums.loadState {
        case .idle, .loading:
            EmptyView()
        case let .failed(message):
            VStack(alignment: .leading, spacing: PBSpacing.s) {
                PBSectionHeader(title: "Smart Albums")
                    .padding(.horizontal, PBSpacing.l)
                PBBanner(message: message, retry: { Task { await smartAlbums.load() } })
            }
        case .loaded where smartAlbums.albums.isEmpty:
            EmptyView()
        case .loaded:
            VStack(alignment: .leading, spacing: PBSpacing.m) {
                PBSectionHeader(title: "Smart Albums")
                    .padding(.horizontal, PBSpacing.l)
                ScrollView(.horizontal, showsIndicators: false) {
                LazyHStack(alignment: .top, spacing: PBSpacing.m) {
                    ForEach(smartAlbums.albums) { album in
                        NavigationLink(value: SmartAlbumRoute(album: album)) {
                            SmartAlbumCard(album: album, apiBaseURL: environment.api.baseURL)
                                .frame(width: PBSize.albumTile)
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
                .padding(.horizontal, PBSpacing.l)
                }
            }
        }
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
            Color(uiColor: .tertiarySystemFill)
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
                .clipShape(RoundedRectangle(cornerRadius: PBRadius.card, style: .continuous))
            Text(collection.name)
                .font(.subheadline.weight(.semibold))
                .lineLimit(2)
            Text(collection.photoCount == 1 ? "1 Photo" : "\(collection.photoCount.formatted()) Photos")
                .font(.caption)
                .foregroundStyle(.secondary)
        }
        .contentShape(Rectangle())
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("\(collection.name), \(CountText.photos(collection.photoCount))")
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
                opensAtTop: store.scope.isRanked,
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
        PBBanner(message: message, retry: retry, dismiss: dismiss)
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
