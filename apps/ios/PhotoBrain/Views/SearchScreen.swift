import SwiftUI

struct SearchScreen: View {
    @ObservedObject var store: SearchStore
    let api: any PhotoBrainAPI

    @Environment(\.accessibilityReduceTransparency) private var reduceTransparency
    @State private var filtersPresented = false

    var body: some View {
        NavigationStack {
            GeometryReader { geometry in
                content(width: geometry.size.width)
            }
            .safeAreaInset(edge: .top, spacing: 0) {
                if store.filters.isActive { filterChips }
            }
            .navigationTitle("Search")
            .navigationBarTitleDisplayMode(.large)
            .searchable(
                text: $store.query,
                placement: .navigationBarDrawer(displayMode: .always),
                prompt: "Search Photos"
            )
            .textInputAutocapitalization(.never)
            .autocorrectionDisabled()
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button {
                        filtersPresented = true
                    } label: {
                        Image(
                            systemName: store.filters.isActive
                                ? "line.3.horizontal.decrease.circle.fill"
                                : "line.3.horizontal.decrease.circle"
                        )
                    }
                    .accessibilityLabel(
                        store.filters.isActive ? "Filters, \(store.filters.summary)" : "Filters"
                    )
                }
            }
        }
        .sheet(isPresented: $filtersPresented) {
            NavigationStack {
                FilterView(store: store)
                    .toolbar {
                        ToolbarItem(placement: .confirmationAction) {
                            Button("Done") { filtersPresented = false }
                        }
                    }
            }
            .task { await store.loadFilterOptionsIfNeeded() }
        }
        .fullScreenCover(isPresented: loupePresented) {
            if let activeID = store.activePhotoID {
                LoupeScreen(
                    records: store.records,
                    activeID: Binding(
                        get: { store.activePhotoID ?? activeID },
                        set: { store.activePhotoID = $0 }
                    ),
                    api: api,
                    curation: store.curation,
                    dismiss: { store.activePhotoID = nil }
                )
            }
        }
    }

    @ViewBuilder
    private func content(width: CGFloat) -> some View {
        switch store.state {
        case .idle:
            ScrollView {
                ContentUnavailableView {
                    Label("Search your library", systemImage: "sparkles")
                } description: {
                    Text("Describe a place, subject, color, or moment. PhotoBrain searches by visual meaning.")
                } actions: {
                    VStack(spacing: 8) {
                        example("sunset on the beach")
                        example("red car")
                        example("mountains in winter")
                    }
                }
                .padding(.top, 40)
            }
        case .waiting, .loading:
            ProgressView("Searching…")
                .frame(maxWidth: .infinity, maxHeight: .infinity)
        case .empty:
            ContentUnavailableView(
                "No Results",
                systemImage: "magnifyingglass",
                description: Text(
                    store.filters.isActive
                        ? "Try clearing one or more filters."
                        : "Try a broader description or a different phrase."
                )
            )
        case let .failed(message):
            ContentUnavailableView {
                Label("Search Unavailable", systemImage: "wifi.exclamationmark")
            } description: {
                Text(message)
            } actions: {
                Button("Try Again") { store.retry() }
                    .buttonStyle(.borderedProminent)
            }
        case .results:
            PhotoResultsGrid(records: store.records, width: width) { store.activePhotoID = $0 }
                .scrollDismissesKeyboard(.interactively)
        }
    }

    private func example(_ query: String) -> some View {
        Button(query) { store.query = query }
            .buttonStyle(.bordered)
    }

    /// Removable chips for each active filter, shown under the search bar.
    private var filterChips: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 8) {
                ForEach(store.filters.activeFields) { entry in
                    Button {
                        store.applyFilters(store.filters.removing(entry.field))
                    } label: {
                        HStack(spacing: 4) {
                            Text(entry.title).lineLimit(1)
                            Image(systemName: "xmark")
                                .font(.caption2.weight(.bold))
                        }
                        .padding(.horizontal, 10)
                        .padding(.vertical, 6)
                        .background(Capsule().fill(Color.accentColor.opacity(0.15)))
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel("Remove filter \(entry.title)")
                }
                Button("Clear All") { store.clearFilters() }
                    .accessibilityLabel("Clear all filters")
            }
            .font(.subheadline)
            .padding(.horizontal, 16)
            .padding(.vertical, 8)
        }
        .background {
            if reduceTransparency {
                Color(uiColor: .systemBackground)
            } else {
                Rectangle().fill(.ultraThinMaterial)
            }
        }
    }

    private var loupePresented: Binding<Bool> {
        Binding(
            get: { store.activePhotoID != nil },
            set: { if !$0 { store.activePhotoID = nil } }
        )
    }
}

/// Lazily loaded square thumbnail grid shared by search and similar-photo results.
struct PhotoResultsGrid: View {
    let records: [PhotoRecord]
    let width: CGFloat
    let onSelect: (Int) -> Void

    var body: some View {
        let columns = Self.columnCount(width: width)
        let side = width / CGFloat(columns)
        ScrollView {
            LazyVGrid(
                columns: Array(repeating: GridItem(.flexible(), spacing: 1), count: columns),
                spacing: 1
            ) {
                ForEach(records) { photo in
                    Button {
                        onSelect(photo.id)
                    } label: {
                        RemotePhotoImage(
                            photo: photo,
                            url: photo.thumbnailURL,
                            contentMode: .fill,
                            showsRetry: false,
                            targetSize: CGSize(width: side, height: side)
                        ) {
                            Color(uiColor: SyntheticThumbnail.color(id: photo.id))
                        }
                        .aspectRatio(1, contentMode: .fit)
                        .clipped()
                        .opacity(photo.isRejected ? 0.35 : 1)
                        .overlay(alignment: .bottomTrailing) { CurationBadge(rating: photo.rating, flag: photo.flag) }
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel(
                        "Open \(photo.filename)"
                            + CurationBadgeText.accessibilitySuffix(rating: photo.rating, flag: photo.flag)
                    )
                }
            }
        }
    }

    static func columnCount(width: CGFloat) -> Int {
        switch width {
        case ..<560: 4
        case ..<768: 5
        case ..<1_024: 7
        default: 8
        }
    }
}

/// Compact star/flag overlay for SwiftUI thumbnails; matches the library grid badge.
struct CurationBadge: View {
    let rating: Int
    let flag: PhotoFlag?

    var body: some View {
        if rating > 0 || flag != nil {
            HStack(spacing: 2) {
                if let stars = CurationBadgeText.stars(rating) { Text(stars) }
                switch flag {
                case .pick: Image(systemName: "flag.fill").foregroundStyle(.white)
                case .reject: Image(systemName: "xmark.circle.fill").foregroundStyle(.red)
                case nil: EmptyView()
                }
            }
            .font(.caption2)
            .foregroundStyle(.white)
            .padding(.horizontal, 4)
            .padding(.vertical, 1)
            .background(RoundedRectangle(cornerRadius: 4).fill(Color.black.opacity(0.72)))
            .padding(4)
            .accessibilityHidden(true)
        }
    }
}
