import SwiftUI

enum AppTab: Hashable, Sendable {
    case library
    case collections
    case search
}
extension LibraryFilters {
    var mediaPickerSelection: MediaKind? {
        mediaKind == .all && isActive ? nil : mediaKind
    }

    func selectingMediaKind(_ selection: MediaKind) -> Self {
        guard selection != .all else { return Self() }
        var updated = self
        updated.mediaKind = selection
        return updated
    }
}


struct LibraryScreen: View {
    @ObservedObject var store: LibraryStore
    let collections: CollectionsStore
    let smartAlbums: SmartAlbumsStore
    @ObservedObject var review: ReviewStore
    @ObservedObject var duplicates: DuplicatesStore
    @ObservedObject var scans: ScanCoordinator
    let environment: AppEnvironment
    @ObservedObject var theme: ThemeController
    @Binding var selectedTab: AppTab

    @Environment(\.accessibilityReduceTransparency) private var reduceTransparency
    @State private var optionsPresented = false
    @State private var addSelectionPresented = false
    @State private var reviewPresented = false
    @State private var duplicatesPresented = false
    @State private var mapPresented = false
    @Environment(\.showTagInLibrary) private var showTagInLibrary

    var body: some View {
        NavigationStack {
            VStack(spacing: 0) {
                header
                if store.filters.isActive { filterSummary }
                if let error = store.refreshError { retainedContentError(error) }
                if let message = scans.statusMessage {
                    Label(message, systemImage: "exclamationmark.triangle.fill")
                        .font(.caption)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(10)
                        .background(Color.orange.opacity(0.18))
                }
                content
            }
            .navigationBarHidden(true)
            .toolbar(store.showsCollapsedHistoryControls ? .hidden : .visible, for: .tabBar)
            .safeAreaInset(edge: .bottom, spacing: 8) {
                VStack(spacing: 8) {
                    ActivityBar(coordinator: scans)
                    if store.showsCollapsedHistoryControls {
                        historyControls
                    }
                }
            }
            .navigationDestination(isPresented: $reviewPresented) {
                ReviewScreen(store: review, collections: collections)
                    .environment(\.showTagInLibrary, showTagInLibrary.map { action in
                        ShowTagInLibraryAction { tag in
                            reviewPresented = false
                            action(tag)
                        }
                    })
            }
            .navigationDestination(isPresented: $duplicatesPresented) {
                DuplicatesScreen(store: duplicates, collections: collections)
                    .environment(\.showTagInLibrary, showTagInLibrary.map { action in
                        ShowTagInLibraryAction { tag in
                            duplicatesPresented = false
                            action(tag)
                        }
                    })
            }
            .navigationDestination(isPresented: $mapPresented) {
                MapScreen(filters: store.filters, collections: collections, curation: store.curation, api: environment.api)
                    .environment(\.showTagInLibrary, showTagInLibrary.map { action in
                        ShowTagInLibraryAction { tag in
                            mapPresented = false
                            action(tag)
                        }
                    })
            }
        }
        .sheet(isPresented: $optionsPresented) {
            LibraryOptionsView(
                store: store,
                smartAlbums: smartAlbums,
                scans: scans,
                environment: environment,
                theme: theme
            )
        }
        .sheet(isPresented: $addSelectionPresented) {
            AddSelectionToCollectionSheet(
                photoIDs: store.orderedRecords.map(\.id).filter(store.selectedPhotoIDs.contains),
                collections: collections,
                completed: { store.endSelection() }
            )
        }
        .fullScreenCover(isPresented: loupePresented) {
            if let activeID = store.activePhotoID {
                LoupeScreen(
                    records: store.orderedRecords,
                    activeID: Binding(
                        get: { store.activePhotoID ?? activeID },
                        set: { store.activePhotoID = $0 }
                    ),
                    api: environment.api,
                    curation: store.curation,
                    collections: collections,
                    dismiss: { store.activePhotoID = nil }
                )
            }
        }
        .alert("Start another scan?", isPresented: duplicateRiskPresented) {
            Button("Cancel", role: .cancel) { scans.cancelDuplicateRisk() }
            Button("Start Anyway", role: .destructive) {
                guard let force = scans.confirmDuplicateRisk() else { return }
                Task { await scans.requestStart(force: force, acceptDuplicateRisk: true) }
            }
        } message: {
            Text(scans.duplicateRiskMessage)
        }
        .task {
            if store.loadState == .idle { await store.load() }
        }
        .task { await review.refreshCounts() }
        .task { await duplicates.refreshCounts() }
    }

    @ViewBuilder
    private var content: some View {
        switch store.loadState {
        case .idle, .loading:
            ProgressView("Loading Library…")
                .frame(maxWidth: .infinity, maxHeight: .infinity)
        case let .failed(message):
            ContentUnavailableView {
                Label("Library Unavailable", systemImage: "wifi.exclamationmark")
            } description: {
                Text(message)
            } actions: {
                Button("Try Again") { Task { await store.load() } }
                    .buttonStyle(.borderedProminent)
            }
        case .empty:
            ContentUnavailableView(
                store.filters.isActive ? "No Matching Photos" : "No Photos",
                systemImage: "photo.on.rectangle.angled",
                description: Text(store.filters.isActive ? "Try clearing one or more filters." : "Scan your library to add photos.")
            )
        default:
            LibraryGrid(
                sections: store.sections,
                selectedID: $store.activePhotoID,
                selectedIDs: $store.selectedPhotoIDs,
                isSelecting: store.isSelecting,
                resetVersion: store.browsingResetVersion,
                contentRevision: store.presentationRevision,
                onLongPress: store.selectFromLongPress,
                onVisibleChange: store.observeVisible,
                onRefresh: {
                    await scans.manualLibraryRefresh()
                    await store.load()
                    await review.refreshCounts()
                    await duplicates.refreshCounts()
                }
            )
            .ignoresSafeArea(edges: .horizontal)
        }
    }

    private var header: some View {
        HStack(spacing: 12) {
            Button {
                optionsPresented = true
            } label: {
                Image(systemName: "ellipsis.circle")
                    .font(.title2)
                    .frame(width: 44, height: 44)
            }
            .accessibilityLabel("Library options")
            .disabled(store.isSelecting)

            VStack(alignment: .leading, spacing: 1) {
                Text("Library")
                    .font(.headline)
                Text(store.headerSubtitle)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .contentTransition(.numericText())
            }
            Spacer()
            if store.isSelecting {
                Button {
                    addSelectionPresented = true
                } label: {
                    Image(systemName: "rectangle.stack.badge.plus")
                        .font(.title2)
                        .frame(width: 44, height: 44)
                }
                .accessibilityLabel("Add to Collection")
                .disabled(store.selectedPhotoIDs.isEmpty)
                Button {
                    store.endSelection()
                } label: {
                    Image(systemName: "xmark.circle.fill")
                        .font(.title2)
                        .frame(width: 44, height: 44)
                }
                .accessibilityLabel("Finish selecting photos")
            } else {
                Button {
                    reviewPresented = true
                } label: {
                    HStack(spacing: 4) {
                        Text("Review")
                        if review.counts.all > 0 {
                            Text(review.counts.all.formatted())
                                .font(.caption.weight(.semibold).monospacedDigit())
                                .foregroundStyle(.white)
                                .padding(.horizontal, 6)
                                .padding(.vertical, 1)
                                .background(Capsule().fill(Color.accentColor))
                                .contentTransition(.numericText())
                        }
                    }
                    .fontWeight(.semibold)
                    .frame(minHeight: 44)
                }
                .accessibilityLabel("Review, \(review.counts.all) photos")
                if duplicates.counts.total > 0 {
                    Button {
                        duplicatesPresented = true
                    } label: {
                        HStack(spacing: 4) {
                            Text("Duplicates")
                            Text(duplicates.counts.total.formatted())
                                .font(.caption.weight(.semibold).monospacedDigit())
                                .foregroundStyle(.white)
                                .padding(.horizontal, 6)
                                .padding(.vertical, 1)
                                .background(Capsule().fill(Color.accentColor))
                                .contentTransition(.numericText())
                        }
                        .fontWeight(.semibold)
                        .frame(minHeight: 44)
                    }
                    .accessibilityLabel("Duplicates, \(duplicates.counts.total) groups")
                }
                Button {
                    mapPresented = true
                } label: {
                    Image(systemName: "map")
                        .font(.title3)
                        .frame(width: 44, height: 44)
                }
                .accessibilityLabel("Map")
                Button("Select") {
                    store.beginSelection()
                }
                .fontWeight(.semibold)
                .accessibilityLabel("Select photos")
                .disabled(store.records.isEmpty)
            }
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 5)
        .background(headerBackground)
    }

    private var filterSummary: some View {
        HStack(spacing: 8) {
            Button {
                optionsPresented = true
            } label: {
                Label(store.filters.summary, systemImage: "line.3.horizontal.decrease.circle.fill")
                    .lineLimit(1)
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Edit filters, \(store.filters.summary)")
            Spacer()
            Button {
                store.clearFilters()
            } label: {
                Image(systemName: "xmark.circle.fill")
            }
            .accessibilityLabel("Clear all filters")
        }
        .font(.subheadline)
        .padding(.horizontal, 14)
        .padding(.vertical, 8)
        .background(headerBackground)
    }

    private func retainedContentError(_ message: String) -> some View {
        HStack(spacing: 8) {
            Image(systemName: "exclamationmark.triangle.fill")
            Text("Couldn’t refresh. Cached photos are still shown.")
                .lineLimit(2)
            Spacer()
            Button("Retry") { Task { await store.load() } }
        }
        .font(.caption)
        .padding(10)
        .background(Color.orange.opacity(0.18))
        .accessibilityLabel("Could not refresh library. \(message)")
    }

    private var historyControls: some View {
        HStack(spacing: 8) {
            Button {
                selectedTab = .collections
            } label: {
                Image(systemName: "rectangle.stack")
                    .frame(width: 40, height: 36)
            }
            .accessibilityLabel("Collections")

            Picker("Time", selection: groupingBinding) {
                ForEach(LibraryGrouping.allCases) { grouping in
                    Text(grouping.title).tag(grouping)
                }
            }
            .pickerStyle(.segmented)

            Button {
                selectedTab = .search
            } label: {
                Image(systemName: "magnifyingglass")
                    .frame(width: 40, height: 36)
            }
            .accessibilityLabel("Search")
        }
        .padding(7)
        .background {
            if reduceTransparency {
                RoundedRectangle(cornerRadius: 16).fill(Color(uiColor: .secondarySystemBackground))
            } else {
                RoundedRectangle(cornerRadius: 16).fill(.regularMaterial)
            }
        }
        .padding(.horizontal, 12)
    }

    @ViewBuilder
    private var headerBackground: some View {
        if reduceTransparency {
            Color(uiColor: .systemBackground)
        } else {
            Rectangle().fill(.ultraThinMaterial)
        }
    }

    private var groupingBinding: Binding<LibraryGrouping> {
        Binding(get: { store.grouping }, set: { value in
            Task { await store.setGrouping(value) }
        })
    }

    private var loupePresented: Binding<Bool> {
        Binding(
            get: { store.activePhotoID != nil },
            set: { if !$0 { store.activePhotoID = nil } }
        )
    }

    private var duplicateRiskPresented: Binding<Bool> {
        Binding(
            get: { scans.requiresDuplicateRiskConfirmation },
            set: { if !$0 { scans.dismissDuplicateRiskPrompt() } }
        )
    }
}

private struct LibraryOptionsView: View {
    @ObservedObject var store: LibraryStore
    let smartAlbums: SmartAlbumsStore
    @ObservedObject var scans: ScanCoordinator
    let environment: AppEnvironment
    @ObservedObject var theme: ThemeController
    @Environment(\.dismiss) private var dismiss
    @State private var confirmForce = false

    var body: some View {
        NavigationStack {
            List {
                Section("Sort") {
                    ForEach(LibrarySort.allCases) { sort in
                        Button {
                            Task { await store.setSort(sort) }
                        } label: {
                            HStack {
                                Text(sort.title)
                                Spacer()
                                if store.sort == sort { Image(systemName: "checkmark") }
                            }
                        }
                        .foregroundStyle(.primary)
                        .accessibilityAddTraits(store.sort == sort ? .isSelected : [])
                    }
                }

                Section {
                    NavigationLink {
                        FilterView(store: store, smartAlbums: smartAlbums)
                    } label: {
                        LabeledContent("Filter", value: store.filters.summary)
                    }
                }

                Section("Library") {
                    Button {
                        dismiss()
                        Task { await scans.requestStart(force: false) }
                    } label: {
                        Label("Scan Library", systemImage: "arrow.clockwise")
                    }
                    .disabled(scans.controlsDisabled)
                    .accessibilityLabel("Scan library")

                    Button {
                        confirmForce = true
                    } label: {
                        Label("Reprocess all photos", systemImage: "arrow.triangle.2.circlepath")
                    }
                    .disabled(scans.controlsDisabled)
                    .accessibilityLabel("Reprocess all photos")
                }

                if let message = scans.statusMessage {
                    Section {
                        Label(message, systemImage: "exclamationmark.triangle")
                            .foregroundStyle(.orange)
                    }
                }

                Section {
                    NavigationLink {
                        SettingsView(environment: environment, theme: theme)
                    } label: {
                        Label("Settings", systemImage: "gearshape")
                    }
                }
            }
            .navigationTitle("Library Options")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") { dismiss() }
                }
            }
            .alert("Reprocess all photos?", isPresented: $confirmForce) {
                Button("Cancel", role: .cancel) {}
                Button("Reprocess all photos", role: .destructive) {
                    dismiss()
                    Task { await scans.requestStart(force: true) }
                }
            } message: {
                Text("This regenerates thumbnails and search embeddings for every photo. Original files are left untouched. This takes longer than a normal library scan.")
            }
        }
    }
}

/// Filter editor shared by Library and Search; each store re-runs its own request on change.
/// When `smartAlbums` is set, the current filters (plus `smartAlbumQuery`) can be saved as a
/// smart album.
struct FilterView<Store: FilterEditingStore>: View {
    @ObservedObject var store: Store
    var smartAlbums: SmartAlbumsStore?
    var smartAlbumQuery: String?
    @State private var saveSmartAlbumPresented = false

    var body: some View {
        List {
            if store.filters.isActive {
                Section {
                    Button("Clear All", role: .destructive) { store.applyFilters(LibraryFilters()) }
                }
            }

            if smartAlbums != nil {
                Section {
                    Button {
                        saveSmartAlbumPresented = true
                    } label: {
                        Label("Save as Smart Album…", systemImage: "rectangle.stack.badge.plus")
                    }
                    .disabled(!store.filters.isActive && smartAlbumQuery == nil)
                }
            }

            Section("Media Type") {
                Picker("Media Type", selection: mediaBinding) {
                    ForEach(LibraryFilters.MediaKind.allCases) { kind in
                        Text(kind.title).tag(Optional(kind))
                    }
                }
                .pickerStyle(.segmented)
            }

            Section("Rating") {
                Picker("Minimum Rating", selection: minRatingBinding) {
                    Text("Any").tag(Int?.none)
                    ForEach(1...5, id: \.self) { stars in
                        Text(LibraryFilters.formatMinRating(stars))
                            .accessibilityLabel(stars == 5 ? "5 stars" : "\(stars) or more stars")
                            .tag(Optional(stars))
                    }
                }
                Picker("Flag", selection: flagBinding) {
                    Text("Any").tag(PhotoFlagFilter?.none)
                    ForEach(PhotoFlagFilter.allCases) { flag in
                        Text(flag.title).tag(Optional(flag))
                    }
                }
            }

            if let options = store.filterOptions {
                Section("Tags") {
                    if options.tags.isEmpty, store.filters.tag == nil {
                        Text("No tags yet")
                            .foregroundStyle(.secondary)
                    } else {
                        NavigationLink {
                            TagFilterCategoryView(
                                options: tagOptions(options.tags),
                                selection: tagBinding
                            )
                        } label: {
                            LabeledContent("Tag", value: store.filters.tag.map(PhotoTagName.displayName) ?? "Any")
                        }
                    }
                }
            }

            Section("Metadata") {
                if let options = store.filterOptions {
                    NavigationLink {
                        StringFilterCategoryView(
                            title: "Camera",
                            allTitle: "All Cameras",
                            options: including(store.filters.camera, in: options.cameras),
                            selection: stringBinding(\.camera)
                        )
                    } label: {
                        LabeledContent("Camera", value: store.filters.camera ?? "All")
                    }
                    NavigationLink {
                        StringFilterCategoryView(
                            title: "Lens",
                            allTitle: "All Lenses",
                            options: including(store.filters.lens, in: options.lenses),
                            selection: stringBinding(\.lens)
                        )
                    } label: {
                        LabeledContent("Lens", value: store.filters.lens ?? "All")
                    }
                    NavigationLink {
                        ISOFilterCategoryView(
                            options: including(store.filters.iso, in: options.isos),
                            selection: isoBinding
                        )
                    } label: {
                        LabeledContent("ISO", value: store.filters.iso.map { "ISO \($0)" } ?? "All")
                    }
                    NavigationLink {
                        StringFilterCategoryView(
                            title: "Date",
                            allTitle: "All Dates",
                            options: including(store.filters.dateMonth, in: options.dates),
                            selection: stringBinding(\.dateMonth),
                            formatter: LibraryFilters.formatMonth
                        )
                    } label: {
                        LabeledContent("Date", value: store.filters.dateMonth.map(LibraryFilters.formatMonth) ?? "All")
                    }
                    if options.cameras.isEmpty, options.lenses.isEmpty, options.isos.isEmpty, options.dates.isEmpty {
                        Text("No metadata filters are available.")
                            .foregroundStyle(.secondary)
                    }
                } else if let error = store.filterOptionsError {
                    VStack(alignment: .leading, spacing: 8) {
                        Text("Filter metadata is unavailable.")
                        Text(error).font(.caption).foregroundStyle(.secondary)
                        Button("Try Again") { Task { await store.retryFilterOptions() } }
                    }
                } else {
                    HStack {
                        ProgressView()
                        Text("Loading filter options…")
                    }
                }
            }
            Section {
                Text("Combine filters to narrow your library. Changes appear immediately.")
                    .foregroundStyle(.secondary)
            }
        }
        .navigationTitle("Filter")
        .sheet(isPresented: $saveSmartAlbumPresented) {
            if let smartAlbums {
                SaveSmartAlbumSheet(store: smartAlbums, filters: store.filters, query: smartAlbumQuery)
            }
        }
    }

    private var mediaBinding: Binding<LibraryFilters.MediaKind?> {
        Binding(
            get: { store.filters.mediaPickerSelection },
            set: { value in
                guard let value else { return }
                store.applyFilters(store.filters.selectingMediaKind(value))
            }
        )
    }

    private func stringBinding(_ keyPath: WritableKeyPath<LibraryFilters, String?>) -> Binding<String?> {
        Binding(
            get: { store.filters[keyPath: keyPath] },
            set: { value in
                var filters = store.filters
                filters[keyPath: keyPath] = value
                store.applyFilters(filters)
            }
        )
    }

    private var isoBinding: Binding<Int?> {
        Binding(
            get: { store.filters.iso },
            set: { value in
                var filters = store.filters
                filters.iso = value
                store.applyFilters(filters)
            }
        )
    }

    private var minRatingBinding: Binding<Int?> {
        Binding(
            get: { store.filters.minRating },
            set: { value in
                var filters = store.filters
                filters.minRating = value
                store.applyFilters(filters)
            }
        )
    }

    private var flagBinding: Binding<PhotoFlagFilter?> {
        Binding(
            get: { store.filters.flag },
            set: { value in
                var filters = store.filters
                filters.flag = value
                store.applyFilters(filters)
            }
        )
    }

    private var tagBinding: Binding<String?> {
        Binding(
            get: { store.filters.tag },
            set: { value in
                var filters = store.filters
                filters.tag = value
                store.applyFilters(filters)
            }
        )
    }

    /// Server order (count desc); an active tag absent from the options stays selectable.
    private func tagOptions(_ tags: [TagCountDTO]) -> [TagFilterCategoryView.Option] {
        let options = tags.map { TagFilterCategoryView.Option(tag: $0.tag, count: $0.count) }
        guard let active = store.filters.tag, !tags.contains(where: { $0.tag == active }) else { return options }
        return [TagFilterCategoryView.Option(tag: active, count: nil)] + options
    }

    private func including<T: Hashable>(_ active: T?, in options: [T]) -> [T] {
        guard let active, !options.contains(active) else { return options }
        return [active] + options
    }
}

private struct StringFilterCategoryView: View {
    let title: String
    let allTitle: String
    let options: [String]
    @Binding var selection: String?
    var formatter: (String) -> String = { $0 }
    @State private var search = ""
    @Environment(\.dismiss) private var dismiss

    private var normalizedSearch: String {
        search.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private var filtered: [String] {
        guard !normalizedSearch.isEmpty else { return options }
        return options.filter { formatter($0).localizedCaseInsensitiveContains(normalizedSearch) }
    }

    var body: some View {
        List {
            Button {
                selection = nil
                dismiss()
            } label: {
                checkmarkRow(allTitle, selected: selection == nil)
            }
            ForEach(filtered, id: \.self) { option in
                Button {
                    selection = option
                    dismiss()
                } label: {
                    checkmarkRow(formatter(option), selected: selection == option)
                }
            }
            if options.isEmpty {
                Text("No filter options available")
                    .foregroundStyle(.secondary)
            } else if filtered.isEmpty {
                Text("No matching options")
                    .foregroundStyle(.secondary)
            }
        }
        .foregroundStyle(.primary)
        .navigationTitle(title)
        .searchable(text: $search, prompt: "Search \(title)")
    }

    private func checkmarkRow(_ text: String, selected: Bool) -> some View {
        HStack {
            Text(text)
            Spacer()
            if selected { Image(systemName: "checkmark") }
        }
        .accessibilityAddTraits(selected ? .isSelected : [])
    }
}

private struct ISOFilterCategoryView: View {
    let options: [Int]
    @Binding var selection: Int?
    @State private var search = ""
    @Environment(\.dismiss) private var dismiss

    private var normalizedSearch: String {
        search.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private var filtered: [Int] {
        guard !normalizedSearch.isEmpty else { return options }
        return options.filter { "ISO \($0)".localizedCaseInsensitiveContains(normalizedSearch) }
    }

    var body: some View {
        List {
            Button {
                selection = nil
                dismiss()
            } label: {
                checkmarkRow("All ISO Values", selected: selection == nil)
            }
            ForEach(filtered, id: \.self) { iso in
                Button {
                    selection = iso
                    dismiss()
                } label: {
                    checkmarkRow("ISO \(iso)", selected: selection == iso)
                }
            }
            if options.isEmpty {
                Text("No filter options available")
                    .foregroundStyle(.secondary)
            } else if filtered.isEmpty {
                Text("No matching options")
                    .foregroundStyle(.secondary)
            }
        }
        .foregroundStyle(.primary)
        .navigationTitle("ISO")
        .searchable(text: $search, prompt: "Search ISO")
    }

    private func checkmarkRow(_ text: String, selected: Bool) -> some View {
        HStack {
            Text(text)
            Spacer()
            if selected { Image(systemName: "checkmark") }
        }
        .accessibilityAddTraits(selected ? .isSelected : [])
    }
}

private struct TagFilterCategoryView: View {
    struct Option: Identifiable, Equatable {
        let tag: String
        /// Photos carrying the tag in scope; nil for an active tag the server no longer lists.
        let count: Int?
        var id: String { tag }
    }

    let options: [Option]
    @Binding var selection: String?
    @State private var search = ""
    @Environment(\.dismiss) private var dismiss

    private var normalizedSearch: String {
        search.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private var filtered: [Option] {
        guard !normalizedSearch.isEmpty else { return options }
        return options.filter {
            PhotoTagName.displayName($0.tag).localizedCaseInsensitiveContains(normalizedSearch)
                || $0.tag.localizedCaseInsensitiveContains(normalizedSearch)
        }
    }

    var body: some View {
        List {
            Button {
                selection = nil
                dismiss()
            } label: {
                row("Any", count: nil, selected: selection == nil)
            }
            ForEach(filtered) { option in
                Button {
                    selection = option.tag
                    dismiss()
                } label: {
                    row(PhotoTagName.displayName(option.tag), count: option.count, selected: selection == option.tag)
                }
            }
            if options.isEmpty {
                Text("No tags yet")
                    .foregroundStyle(.secondary)
            } else if filtered.isEmpty {
                Text("No matching tags")
                    .foregroundStyle(.secondary)
            }
        }
        .foregroundStyle(.primary)
        .navigationTitle("Tag")
        .searchable(text: $search, prompt: "Search Tags")
    }

    private func row(_ text: String, count: Int?, selected: Bool) -> some View {
        HStack {
            Text(text)
            Spacer()
            if let count {
                Text(count.formatted())
                    .font(.callout.monospacedDigit())
                    .foregroundStyle(.secondary)
            }
            if selected { Image(systemName: "checkmark") }
        }
        .accessibilityElement(children: .combine)
        .accessibilityLabel(count.map { "\(text), \($0) photos" } ?? text)
        .accessibilityAddTraits(selected ? .isSelected : [])
    }
}
