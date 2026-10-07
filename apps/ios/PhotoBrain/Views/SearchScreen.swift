import SwiftUI

struct SearchScreen: View {
    @ObservedObject var store: SearchStore
    let api: any PhotoBrainAPI
    let collections: CollectionsStore
    let smartAlbums: SmartAlbumsStore

    @State private var filtersPresented = false
    @State private var saveSmartAlbumPresented = false

    var body: some View {
        NavigationStack {
            GeometryReader { geometry in
                content(width: geometry.size.width)
            }
            .safeAreaInset(edge: .top, spacing: 0) {
                if store.state != .idle || store.filters.isActive { filterBar }
            }
            .navigationTitle("Search")
            .navigationBarTitleDisplayMode(.large)
            .searchable(
                text: $store.query,
                prompt: "Describe a photo"
            )
            .textInputAutocapitalization(.never)
            .autocorrectionDisabled()
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button {
                        saveSmartAlbumPresented = true
                    } label: {
                        Image(systemName: "rectangle.stack.badge.plus")
                    }
                    .accessibilityLabel("Save as Smart Album")
                    .disabled(savedQuery == nil)
                }

            }
        }
        .sheet(isPresented: $filtersPresented) {
            NavigationStack {
                FilterView(store: store, smartAlbums: smartAlbums, smartAlbumQuery: savedQuery)
                    .toolbar {
                        ToolbarItem(placement: .confirmationAction) {
                            Button("Done") { filtersPresented = false }
                        }
                    }
            }
            .task { await store.loadFilterOptionsIfNeeded() }
        }
        .sheet(isPresented: $saveSmartAlbumPresented) {
            if let savedQuery {
                SaveSmartAlbumSheet(store: smartAlbums, filters: store.filters, query: savedQuery)
            }
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
                    collections: collections,
                    dismiss: { store.activePhotoID = nil }
                )
            }
        }
    }

    @ViewBuilder
    private func content(width: CGFloat) -> some View {
        switch store.state {
        case .idle:
            SearchBrowseView(store: store, width: width)
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
            PhotoResultsGrid(
                records: store.records,
                width: width,
                featuresTopResult: true,
                header: "Best matches for “\(savedQuery ?? "")” · \(store.records.count.formatted())"
            ) { store.activePhotoID = $0 }
                .scrollDismissesKeyboard(.interactively)
        }
    }

    /// Filters button plus removable chips for each active filter, shown under the search bar.
    /// The toolbar's Filters button is hidden while the search field is active, so this keeps
    /// filters reachable without cancelling the query.
    private var filterBar: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: PBSpacing.s) {
                FilterChip(
                    title: "Filters",
                    systemImage: "line.3.horizontal.decrease",
                    isOn: store.filters.isActive
                ) {
                    filtersPresented = true
                }
                .accessibilityLabel(
                    store.filters.isActive ? "Edit filters, \(store.filters.summary)" : "Add filters"
                )
                ForEach(LibraryFilters.MediaKind.allCases.filter { $0 != .all }) { kind in
                    FilterChip(title: kind == .standard ? "Photos" : kind.title, isOn: store.filters.mediaKind == kind) {
                        var updated = store.filters
                        updated.mediaKind = updated.mediaKind == kind ? .all : kind
                        store.applyFilters(updated)
                    }
                }
                ForEach(store.filters.activeFields.filter { $0.field != .mediaKind }) { entry in
                    FilterChip(title: entry.title, isOn: true, removable: true) {
                        store.applyFilters(store.filters.removing(entry.field))
                    }
                    .accessibilityLabel("Remove filter \(entry.title)")
                }
            }
            .padding(.horizontal, PBSpacing.l)
            .padding(.vertical, PBSpacing.s)
        }
        .background(.bar)
    }

    /// The trimmed search text a smart album would save; `nil` while the field is blank.
    private var savedQuery: String? {
        let trimmed = store.query.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? nil : trimmed
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
    /// Ranked results: the first match spans two columns and two rows at the top.
    var featuresTopResult = false
    var header: String?
    let onSelect: (Int) -> Void

    var body: some View {
        let columns = featuresTopResult ? 3 : Self.columnCount(width: width)
        let side = width / CGFloat(columns)
        let featured = featuresTopResult && records.count >= 3 ? Array(records.prefix(3)) : []
        let rest = Array(records.dropFirst(featured.count))
        ScrollView {
            if let header {
                Text(header)
                    .font(.footnote.weight(.medium))
                    .foregroundStyle(.secondary)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.horizontal, PBSpacing.l)
                    .padding(.vertical, PBSpacing.s)
            }
            if featured.count == 3 {
                HStack(spacing: 1) {
                    tile(featured[0], side: side * 2)
                        .frame(width: side * 2 - 1, height: side * 2)
                    VStack(spacing: 1) {
                        tile(featured[1], side: side)
                            .frame(width: side, height: side - 0.5)
                        tile(featured[2], side: side)
                            .frame(width: side, height: side - 0.5)
                    }
                }
                .padding(.bottom, 1)
            }
            LazyVGrid(
                columns: Array(repeating: GridItem(.flexible(), spacing: 1), count: columns),
                spacing: 1
            ) {
                ForEach(rest) { photo in
                    tile(photo, side: side)
                        .aspectRatio(1, contentMode: .fit)
                }
            }
        }
        .accessibilityIdentifier("photo-results")
    }

    private func tile(_ photo: PhotoRecord, side: CGFloat) -> some View {
        Button {
            onSelect(photo.id)
        } label: {
            Color(uiColor: SyntheticThumbnail.color(id: photo.id))
                .overlay {
                    RemotePhotoImage(
                        photo: photo,
                        url: photo.thumbnailURL,
                        contentMode: .fill,
                        showsRetry: false,
                        targetSize: CGSize(width: side, height: side)
                    ) {
                        Color(uiColor: SyntheticThumbnail.color(id: photo.id))
                    }
                }
                .clipped()
                .opacity(photo.isRejected ? 0.35 : 1)
                .overlay(alignment: .bottomTrailing) {
                    VStack(alignment: .trailing, spacing: 0) {
                        CurationBadge(rating: photo.rating, flag: photo.flag)
                        photo.mediaBadge.map(MediaBadgeView.init)
                    }
                }
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel(
            "Open \(photo.filename)"
                + (photo.mediaBadge.map { ", \($0.accessibilityText)" } ?? "")
                + CurationBadgeText.accessibilitySuffix(rating: photo.rating, flag: photo.flag)
        )
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
            .font(.caption2.weight(.semibold))
            .foregroundStyle(.white)
            .padding(.horizontal, 4)
            .padding(.vertical, 1)
            .background(RoundedRectangle(cornerRadius: PBRadius.badge, style: .continuous).fill(PBColor.badgeBackground))
            .padding(4)
            .accessibilityHidden(true)
        }
    }
}

/// Duration or LIVE overlay for SwiftUI thumbnails; matches the library grid badge.
struct MediaBadgeView: View {
    let badge: MediaBadge

    var body: some View {
        HStack(spacing: 2) {
            Image(systemName: badge.systemImage)
            Text(badge.text).monospacedDigit()
        }
        .font(.caption2.weight(.semibold))
        .foregroundStyle(.white)
        .padding(.horizontal, 4)
        .padding(.vertical, 1)
        .background(RoundedRectangle(cornerRadius: PBRadius.badge, style: .continuous).fill(PBColor.badgeBackground))
        .padding(4)
        .accessibilityHidden(true)
    }
}

/// Search's idle state: example prompts, then Places and Categories rows from the library's
/// filter options. Prompts fill the query; places and tags open the Library filtered to them.
private struct SearchBrowseView: View {
    @ObservedObject var store: SearchStore
    let width: CGFloat
    @Environment(\.showInLibrary) private var showInLibrary

    private static let examples = [
        "dog on the beach", "sunset over water", "birthday cake",
        "snowy mountains", "city at night", "red car",
    ]

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: PBSpacing.xl) {
                VStack(alignment: .leading, spacing: PBSpacing.m) {
                    PBSectionHeader(title: "Try describing a moment")
                    Text("PhotoBrain searches by visual meaning: places, subjects, colors, or moods.")
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                    FlowLayout(spacing: PBSpacing.s) {
                        ForEach(Self.examples, id: \.self) { example in
                            FilterChip(title: "“\(example)”") { store.query = example }
                                .accessibilityLabel("Search for \(example)")
                        }
                    }
                }
                .padding(.horizontal, PBSpacing.l)
                .accessibilityElement(children: .contain)
                .accessibilityLabel("Search your library")

                if let options = store.filterOptions {
                    if !options.places.isEmpty {
                        browseRow("Places", items: options.places.prefix(12).map { place in
                            let country = options.countries.first { $0.code == place.countryCode }?.name ?? place.countryCode
                            return BrowseItem(id: "p-\(place.id)", title: place.name, count: place.count) {
                                showInLibrary?(.place(PhotoPlaceDTO(
                                    id: place.id,
                                    city: place.name,
                                    region: place.region,
                                    country: country,
                                    countryCode: place.countryCode
                                )))
                            }
                        })
                    }
                    if !options.tags.isEmpty {
                        browseRow("Categories", items: options.tags.prefix(16).map { tag in
                            BrowseItem(id: "t-\(tag.tag)", title: PhotoTagName.displayName(tag.tag), count: tag.count) {
                                showInLibrary?(.tag(tag.tag))
                            }
                        })
                    }
                }
            }
            .padding(.vertical, PBSpacing.l)
        }
        .task { await store.loadFilterOptionsIfNeeded() }
    }

    private struct BrowseItem: Identifiable {
        let id: String
        let title: String
        let count: Int
        let action: () -> Void
    }

    private func browseRow(_ title: String, items: [BrowseItem]) -> some View {
        VStack(alignment: .leading, spacing: PBSpacing.m) {
            PBSectionHeader(title: title)
                .padding(.horizontal, PBSpacing.l)
            ScrollView(.horizontal, showsIndicators: false) {
                LazyHStack(spacing: PBSpacing.m) {
                    ForEach(Array(items.enumerated()), id: \.element.id) { index, item in
                        Button(action: item.action) {
                            CoverCard(title: item.title, subtitle: CountText.photos(item.count), width: 120, height: 120) {
                                LinearGradient(
                                    colors: Self.gradient(index: index, seed: title),
                                    startPoint: .topLeading,
                                    endPoint: .bottomTrailing
                                )
                            }
                        }
                        .buttonStyle(.plain)
                        .accessibilityElement(children: .ignore)
                        .accessibilityLabel("\(item.title), \(CountText.photos(item.count))")
                        .accessibilityAddTraits(.isButton)
                    }
                }
                .padding(.horizontal, PBSpacing.l)
            }
        }
    }

    /// A stable two-stop gradient per tile; browse tiles have no cover photo.
    private static func gradient(index: Int, seed: String) -> [Color] {
        let base = Double((index * 53 + seed.count * 29) % 360) / 360
        return [
            Color(hue: base, saturation: 0.55, brightness: 0.85),
            Color(hue: (base + 0.08).truncatingRemainder(dividingBy: 1), saturation: 0.65, brightness: 0.6),
        ]
    }
}

/// Wraps children onto new lines, left-aligned.
struct FlowLayout: Layout {
    var spacing: CGFloat = 8

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        let width = proposal.width ?? .infinity
        var x: CGFloat = 0, y: CGFloat = 0, rowHeight: CGFloat = 0, maxX: CGFloat = 0
        for subview in subviews {
            let size = subview.sizeThatFits(.unspecified)
            if x > 0, x + size.width > width {
                x = 0
                y += rowHeight + spacing
                rowHeight = 0
            }
            x += size.width + spacing
            maxX = max(maxX, x - spacing)
            rowHeight = max(rowHeight, size.height)
        }
        return CGSize(width: min(maxX, width), height: y + rowHeight)
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        var x = bounds.minX, y = bounds.minY, rowHeight: CGFloat = 0
        for subview in subviews {
            let size = subview.sizeThatFits(.unspecified)
            if x > bounds.minX, x + size.width > bounds.maxX {
                x = bounds.minX
                y += rowHeight + spacing
                rowHeight = 0
            }
            subview.place(at: CGPoint(x: x, y: y), proposal: ProposedViewSize(size))
            x += size.width + spacing
            rowHeight = max(rowHeight, size.height)
        }
    }
}
