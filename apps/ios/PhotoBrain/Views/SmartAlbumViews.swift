import SwiftUI

/// Navigation value for a smart album; detail screens read the live name from the store.
struct SmartAlbumRoute: Hashable {
    let album: SmartAlbumDTO

    static func == (lhs: Self, rhs: Self) -> Bool { lhs.album.id == rhs.album.id }
    func hash(into hasher: inout Hasher) { hasher.combine(album.id) }
}

/// Collections-tab card: cover (when the album has matches), name, and the live photo count,
/// or the saved search text with a magnifier glyph for query albums.
struct SmartAlbumCard: View {
    let album: SmartAlbumDTO
    let apiBaseURL: URL

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Color(uiColor: .secondarySystemBackground)
                .aspectRatio(1, contentMode: .fit)
                .overlay {
                    if let cover = album.cover, let url = album.coverURL(apiBaseURL: apiBaseURL) {
                        CollectionCoverImage(photoID: cover.photoId, url: url)
                    } else {
                        Image(systemName: album.query == nil ? "line.3.horizontal.decrease.circle" : "magnifyingglass")
                            .font(.largeTitle)
                            .foregroundStyle(.secondary)
                    }
                }
                .clipShape(RoundedRectangle(cornerRadius: 10))
            Text(album.name)
                .font(.subheadline.weight(.semibold))
                .lineLimit(1)
            Group {
                if let count = album.photoCount {
                    Text(count == 1 ? "1 Photo" : "\(count.formatted()) Photos")
                } else {
                    Label(album.query ?? "Search", systemImage: "magnifyingglass")
                        .lineLimit(1)
                }
            }
            .font(.caption)
            .foregroundStyle(.secondary)
        }
        .contentShape(Rectangle())
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(accessibilityText)
        .accessibilityAddTraits(.isButton)
    }

    private var accessibilityText: String {
        if let count = album.photoCount {
            return "\(album.name), smart album, \(CountText.photos(count))"
        }
        return "\(album.name), smart album, search for \(album.query ?? "")"
    }
}

/// One smart album's live results with the same grid and loupe as a collection. Filter-only
/// albums list photos matching the saved filters; query albums run the saved semantic search.
struct SmartAlbumDetailScreen: View {
    let album: SmartAlbumDTO
    @ObservedObject var smartAlbums: SmartAlbumsStore
    let collections: CollectionsStore
    let api: any PhotoBrainAPI
    @StateObject private var store: LibraryStore

    init(
        album: SmartAlbumDTO,
        smartAlbums: SmartAlbumsStore,
        collections: CollectionsStore,
        curation: PhotoCurationCenter,
        api: any PhotoBrainAPI
    ) {
        self.album = album
        self.smartAlbums = smartAlbums
        self.collections = collections
        self.api = api
        _store = StateObject(
            wrappedValue: LibraryStore(
                api: api,
                curation: curation,
                scope: .smartAlbum(filters: album.filters, query: album.query)
            )
        )
    }

    var body: some View {
        ScopedPhotoGrid(
            store: store,
            collections: collections,
            api: api,
            title: smartAlbums.album(id: album.id)?.name ?? album.name,
            noun: "Smart Album",
            emptyTitle: "No Matching Photos",
            emptyDescription: album.query == nil
                ? "No photos match this smart album’s filters yet."
                : "No photos match this smart album’s search.",
            onRefresh: { await smartAlbums.load() }
        )
    }
}

/// Names and saves the current filters (and search text, when given) as a smart album.
/// Validation and server errors such as a taken name are shown inline; the sheet stays open.
struct SaveSmartAlbumSheet: View {
    @ObservedObject var store: SmartAlbumsStore
    /// The savable part of the current filters; view scopes are never saved.
    let filters: LibraryFilters
    /// Trimmed search text, or `nil` to save filters only.
    let query: String?

    init(store: SmartAlbumsStore, filters: LibraryFilters, query: String?) {
        self.store = store
        self.filters = filters.savableCriteria
        self.query = query
    }

    @Environment(\.dismiss) private var dismiss
    @State private var name = ""
    @State private var errorMessage: String?
    @State private var isSaving = false
    @FocusState private var nameFocused: Bool

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    TextField("Name", text: $name)
                        .focused($nameFocused)
                        .submitLabel(.done)
                        .onSubmit { Task { await save() } }
                        .onChange(of: name) { _, _ in errorMessage = nil }
                } footer: {
                    if let errorMessage {
                        Text(errorMessage)
                            .foregroundStyle(.red)
                            .accessibilityLabel("Error: \(errorMessage)")
                    }
                }
                Section("Saved Criteria") {
                    if let query {
                        LabeledContent("Search", value: query)
                    }
                    LabeledContent("Filters", value: filters.isActive ? filters.summary : "None")
                }
                Section {
                    Text("Smart albums update automatically as your library changes. Deleting one never deletes photos.")
                        .foregroundStyle(.secondary)
                }
            }
            .disabled(isSaving)
            .navigationTitle("Save as Smart Album")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    if isSaving {
                        ProgressView()
                    } else {
                        Button("Save") { Task { await save() } }
                            .disabled(name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                    }
                }
            }
        }
        .presentationDetents([.medium, .large])
        .onAppear {
            name = String((query ?? filters.summary).prefix(SmartAlbumDraft.maximumNameLength))
            nameFocused = true
        }
    }

    private func save() async {
        guard !isSaving else { return }
        isSaving = true
        errorMessage = nil
        defer { isSaving = false }
        do {
            _ = try await store.create(name: name, filters: SmartAlbumFilters(filters), query: query)
            dismiss()
        } catch is CancellationError {
            return
        } catch {
            errorMessage = CollectionsStore.message(for: error)
        }
    }
}
