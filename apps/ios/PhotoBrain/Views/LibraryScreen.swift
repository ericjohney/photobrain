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
    @ObservedObject var onThisDay: OnThisDayStore
    let collections: CollectionsStore
    let smartAlbums: SmartAlbumsStore
    @ObservedObject var events: EventsStore
    @ObservedObject var review: ReviewStore
    @ObservedObject var duplicates: DuplicatesStore
    @ObservedObject var scans: ScanCoordinator
    let environment: AppEnvironment
    @ObservedObject var theme: ThemeController
    @Binding var selectedTab: AppTab
    @Binding var utility: LibraryUtility?

    @State private var optionsPresented = false
    @State private var addSelectionPresented = false
    @State private var loupeTransition = LoupeZoomTransition()
    /// Pinched column counts per grouping (`years:9,months:5,days:3`).
    @AppStorage("com.photobrain.gridColumns") private var storedColumns = ""
    @Environment(\.showInLibrary) private var showInLibrary
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    private var isPad: Bool { UIDevice.current.userInterfaceIdiom == .pad }
    /// Safe-area insets with the tab bar showing; kept while it is collapsed so the grid's
    /// insets never jump.
    @State private var chromeInsets = EdgeInsets()
    @State private var scrollToNewestVersion = 0

    var body: some View {
        NavigationStack {
            GeometryReader { proxy in
                ZStack(alignment: .top) {
                    if store.loadState == .content {
                        content
                            .ignoresSafeArea()
                    } else {
                        content
                            .padding(.top, 64)
                    }
                    header
                }
                .overlay(alignment: .bottom) { bottomChrome }
                .onAppear { updateChromeInsets(proxy.safeAreaInsets) }
                .onChange(of: proxy.safeAreaInsets) { _, insets in updateChromeInsets(insets) }
            }
            .toolbar(.hidden, for: .navigationBar)

            .toolbar(isBrowsingCollapsed ? .hidden : .visible, for: .tabBar)
            .animation(reduceMotion ? nil : .smooth(duration: 0.3), value: isBrowsingCollapsed)
            .navigationDestination(item: $utility) { destination in
                utilityScreen(destination)
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
        .loupeCover(isPresented: store.activeItemID != nil) {
            if let activeID = store.activeItemID {
                LoupeScreen(
                    items: store.orderedItems,
                    activeID: Binding(
                        get: { store.activeItemID ?? activeID },
                        set: { store.activeItemID = $0 }
                    ),
                    api: environment.api,
                    curation: store.curation,
                    collections: collections,
                    dismiss: { store.activeItemID = nil },
                    transition: loupeTransition
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
        .task {
            if onThisDay.state == .idle { await onThisDay.load() }
        }
        .task { await events.loadIfNeeded() }
        .task(id: events.events) {
            await store.setEventTitles(EventDayIndex.titles(for: events.events))
        }
        .task { await review.refreshCounts() }
        .task { await duplicates.refreshCounts() }
    }

    // MARK: Floating chrome

    /// True while photos fill the screen, so the title and glass buttons sit over the scrim.
    private var overPhotos: Bool {
        store.loadState == .content
    }

    /// Scrolled back in time: Photos swaps the tab bar for the Years · Months · All switcher.
    private var isBrowsingCollapsed: Bool {
        !isPad && store.isBrowsingHistory && showsGroupingControl
    }

    private func updateChromeInsets(_ insets: EdgeInsets) {
        guard !isBrowsingCollapsed || chromeInsets == EdgeInsets() else { return }
        if insets != chromeInsets { chromeInsets = insets }
    }

    /// Grid insets: below the title at the oldest edge, above the tab bar at the newest.
    private var gridInsets: EdgeInsets {
        let groupingHeight = isPad && showsGroupingControl ? PBSize.control + PBSpacing.s : 0
        return EdgeInsets(
            top: chromeInsets.top + 64, leading: 0,
            bottom: chromeInsets.bottom + PBSpacing.s + groupingHeight, trailing: 0
        )
    }

    /// Photos' title block over the scrim: Library, the visible date or item count, and glass
    /// buttons; then the Filtered capsule and warnings.
    private var header: some View {
        VStack(alignment: .leading, spacing: PBSpacing.s) {
            HStack(alignment: .top, spacing: PBSpacing.s) {
                VStack(alignment: .leading, spacing: 0) {
                    Text(store.isSelecting ? store.headerSubtitle : "Library")
                        .font(.largeTitle.bold())
                        .lineLimit(1)
                        .minimumScaleFactor(0.7)
                        .accessibilityIdentifier("library-title")
                        .accessibilityAddTraits(.isHeader)
                    if !store.isSelecting, overPhotos {
                        Text(store.headerSubtitle)
                            .font(.subheadline.weight(.semibold))
                            .monospacedDigit()
                            .contentTransition(.numericText())
                    }
                }
                .shadow(color: overPhotos ? .black.opacity(0.35) : .clear, radius: 6)
                Spacer(minLength: 0)
                headerButtons
            }
            if !store.isSelecting, store.filters.isActive {
                filteredCapsule
                if let device = store.device, device.visibility != .server, device.isAvailable,
                   !device.assets.isEmpty,
                   device.assets.first.map({ LocalFilterSupport.matches($0, filters: store.filters) == nil }) == true {
                    Text("Photos not yet backed up are hidden by this filter.")
                        .font(.footnote)
                        .shadow(color: overPhotos ? .black.opacity(0.35) : .clear, radius: 4)
                }
            }
            if let error = store.refreshError {
                PBBanner(message: "Couldn’t refresh. Cached photos are still shown.", retry: { Task { await store.load() } })
                    .accessibilityLabel("Could not refresh library. \(error)")
            }
            if let message = scans.statusMessage {
                PBBanner(message: message)
            }
        }
        .padding(.horizontal, PBSpacing.l)
        .padding(.top, PBSpacing.xs)
        .foregroundStyle(overPhotos ? Color.white : Color.primary)
        .environment(\.colorScheme, overPhotos ? .dark : colorSchemeOutsidePhotos)
    }

    @Environment(\.colorScheme) private var colorSchemeOutsidePhotos

    @ViewBuilder
    private var headerButtons: some View {
        if store.isSelecting {
            Button {
                addSelectionPresented = true
            } label: {
                GlassIconLabel(systemImage: "rectangle.stack.badge.plus")
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Add to Collection")
            .disabled(store.selectedPhotoIDs.isEmpty)
            glassTextButton("Done") { store.endSelection() }
                .accessibilityLabel("Finish selecting photos")
        } else {
            moreMenu
            glassTextButton("Select") { store.beginSelection() }
                .accessibilityLabel("Select photos")
                .disabled(store.orderedItems.isEmpty)
        }
    }

    private func glassTextButton(_ title: String, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Text(title)
                .font(.body.weight(.semibold))
                .padding(.horizontal, PBSpacing.l)
                .frame(height: PBSize.control)
                .pbGlass(in: Capsule(), interactive: true)
                .contentShape(Capsule())
        }
        .buttonStyle(.plain)
    }

    private var filteredCapsule: some View {
        Button {
            store.clearFilters()
        } label: {
            HStack(spacing: 6) {
                Image(systemName: "line.3.horizontal.decrease")
                Text("Filtered: \(filterTitle)")
                    .lineLimit(1)
                Image(systemName: "xmark.circle.fill")
                    .foregroundStyle(.secondary)
            }
            .font(.subheadline.weight(.medium))
            .padding(.horizontal, 14)
            .padding(.vertical, 8)
            .pbGlass(in: Capsule(), interactive: true)
        }
        .buttonStyle(.plain)
        .accessibilityLabel("Clear all filters")
        .accessibilityValue(filterTitle)
    }

    /// Scan activity, then (scrolled back in time) Library · Years/Months/All · Search in
    /// place of the tab bar.
    private var bottomChrome: some View {
        VStack(spacing: PBSpacing.s) {
            ActivityBar(coordinator: scans)
            if isBrowsingCollapsed {
                collapsedBar
                    .transition(.move(edge: .bottom).combined(with: .opacity))
            } else if isPad, showsGroupingControl {
                collapsedBar
                    .frame(maxWidth: 420)
            }
        }
        .padding(.bottom, isBrowsingCollapsed ? 0 : PBSpacing.s)
    }

    private var collapsedBar: some View {
        HStack(spacing: PBSpacing.s) {
            Button {
                scrollToNewestVersion += 1
            } label: {
                GlassIconLabel(systemImage: "photo.on.rectangle", tint: PBColor.accent)
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Library")
            .accessibilityHint("Scrolls to the newest photos")
            groupingSwitcher
            Button {
                selectedTab = .search
            } label: {
                GlassIconLabel(systemImage: "magnifyingglass")
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Search")
        }
        .padding(.horizontal, PBSpacing.l)
        .padding(.bottom, PBSpacing.xs)
    }

    /// Photos-style More menu: Sort and a single-choice Filter, then Library Options.
    /// Review, Duplicates, Calendar, Map, and Gear Stats live in Albums › Utilities.
    private var moreMenu: some View {
        Menu {
            Section {
                Picker(selection: sortBinding) {
                    ForEach(LibrarySort.allCases) { sort in
                        Text(sort.title).tag(sort)
                    }
                } label: {
                    Label("Sort", systemImage: "arrow.up.arrow.down")
                }
                .pickerStyle(.menu)
                Menu {
                    Picker("Filter", selection: quickFilterBinding) {
                        ForEach(LibraryQuickFilter.allCases) { filter in
                            Label(filter.title, systemImage: filter.systemImage).tag(Optional(filter))
                        }
                    }
                    .pickerStyle(.inline)
                } label: {
                    Label(
                        store.filters.isActive ? "Filter: \(filterTitle)" : "Filter",
                        systemImage: store.filters.isActive
                            ? "line.3.horizontal.decrease.circle.fill"
                            : "line.3.horizontal.decrease.circle"
                    )
                }
            }
            if let device = store.device, device.isAvailable {
                Section {
                    Menu {
                        Picker("Show", selection: visibilityBinding(device)) {
                            ForEach(DeviceLibrary.Visibility.allCases) { visibility in
                                Text(visibility.title).tag(visibility)
                            }
                        }
                        .pickerStyle(.inline)
                    } label: {
                        Label("Show: \(device.visibility.title)", systemImage: "iphone.and.arrow.forward")
                    }
                }
            }
            Section {
                Button {
                    optionsPresented = true
                } label: {
                    Label("Library Options", systemImage: "gearshape")
                }
            }
        } label: {
            GlassIconLabel(systemImage: "line.3.horizontal.decrease")
        }
        .accessibilityLabel("Library options")
    }

    private func visibilityBinding(_ device: DeviceLibrary) -> Binding<DeviceLibrary.Visibility> {
        Binding(get: { device.visibility }, set: { store.setVisibility($0) })
    }

    private var quickFilterBinding: Binding<LibraryQuickFilter?> {
        Binding(
            get: { LibraryQuickFilter(matching: store.filters) },
            set: { filter in store.applyFilters(filter?.filters ?? LibraryFilters()) }
        )
    }

    /// The active filter's name, or the summary for filters set elsewhere (e.g. a calendar day).
    private var filterTitle: String {
        LibraryQuickFilter(matching: store.filters)?.title ?? store.filters.summary
    }

    // MARK: Grouping and density

    private var showsGroupingControl: Bool {
        !store.isSelecting && store.sort == .captured && !store.orderedItems.isEmpty
    }

    /// Photos' glass Years · Months · All switcher.
    private var groupingSwitcher: some View {
        HStack(spacing: 0) {
            ForEach(LibraryGrouping.segments) { grouping in
                let selected = store.grouping == grouping
                Button {
                    groupingBinding.wrappedValue = grouping
                } label: {
                    Text(grouping.title)
                        .font(.subheadline.weight(selected ? .semibold : .regular))
                        .frame(maxWidth: .infinity)
                        .frame(height: PBSize.control - 8)
                        .background {
                            if selected {
                                Capsule().fill(Color.primary.opacity(0.14))
                            }
                        }
                        .contentShape(Capsule())
                }
                .buttonStyle(.plain)
                .accessibilityAddTraits(selected ? .isSelected : [])
            }
        }
        .padding(4)
        .frame(maxWidth: 280)
        .pbGlass(in: Capsule(), interactive: true)
        .accessibilityElement(children: .contain)
        .accessibilityLabel("Group By")
    }

    private var columnsByGrouping: [String: Int] {
        Dictionary(uniqueKeysWithValues: storedColumns.split(separator: ",").compactMap { pair -> (String, Int)? in
            let parts = pair.split(separator: ":")
            guard parts.count == 2, let value = Int(parts[1]) else { return nil }
            return (String(parts[0]), value)
        })
    }

    private var currentColumns: Int {
        columnsByGrouping[store.grouping.rawValue] ?? store.grouping.defaultPhoneColumns
    }

    private func storeColumns(_ columns: Int) {
        var values = columnsByGrouping
        values[store.grouping.rawValue] = columns
        storedColumns = values.sorted { $0.key < $1.key }.map { "\($0.key):\($0.value)" }.joined(separator: ",")
    }

    // MARK: Content

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
            if store.filters.isActive {
                ContentUnavailableView {
                    Label(
                        LibraryQuickFilter(matching: store.filters)?.emptyTitle ?? "No Matching Photos",
                        systemImage: "line.3.horizontal.decrease.circle"
                    )
                } description: {
                    Text("Nothing in your library matches this filter.")
                } actions: {
                    Button("Show All Items") { store.clearFilters() }
                        .buttonStyle(.borderedProminent)
                }
            } else {
                ContentUnavailableView(
                    "No Photos",
                    systemImage: "photo.on.rectangle.angled",
                    description: Text("Scan your library to add photos.")
                )
            }
        default:
            LibraryGrid(
                sections: store.sections,
                selectedID: $store.activeItemID,
                selectedIDs: $store.selectedItemIDs,
                isSelecting: store.isSelecting,
                resetVersion: store.browsingResetVersion,
                contentRevision: store.presentationRevision,
                onLongPress: store.selectFromLongPress,
                onVisibleChange: store.observeVisible,
                transition: loupeTransition,
                columns: currentColumns,
                onPinchColumns: storeColumns,
                fullBleedInsets: gridInsets,
                scrollToNewestVersion: scrollToNewestVersion,
                onRefresh: {
                    await scans.manualLibraryRefresh()
                    await store.load()
                    await onThisDay.load()
                    await events.load()
                    await review.refreshCounts()
                    await duplicates.refreshCounts()
                }
            )
        }
    }

    @ViewBuilder
    private func utilityScreen(_ destination: LibraryUtility) -> some View {
        let close = showInLibrary.map { action in
            ShowInLibraryAction { shortcut in
                utility = nil
                action(shortcut)
            }
        }
        switch destination {
        case .review:
            ReviewScreen(store: review, collections: collections)
                .environment(\.showInLibrary, close)
        case .duplicates:
            DuplicatesScreen(store: duplicates, collections: collections)
                .environment(\.showInLibrary, close)
        case .map:
            MapScreen(filters: store.filters, collections: collections, curation: store.curation, api: environment.api)
                .environment(\.showInLibrary, close)
        }
    }

    private var groupingBinding: Binding<LibraryGrouping> {
        Binding(get: { store.grouping }, set: { value in
            Task { await store.setGrouping(value) }
        })
    }

    private var sortBinding: Binding<LibrarySort> {
        Binding(get: { store.sort }, set: { value in
            Task { await store.setSort(value) }
        })
    }


    private var duplicateRiskPresented: Binding<Bool> {
        Binding(
            get: { scans.requiresDuplicateRiskConfirmation },
            set: { if !$0 { scans.dismissDuplicateRiskPrompt() } }
        )
    }
}

/// Library screens reachable from the More menu and the Albums tab's Utilities list.
enum LibraryUtility: String, Hashable, Identifiable, Sendable {
    case review
    case duplicates
    case map

    var id: String { rawValue }
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

                if let device = store.device {
                    LibraryVisibilitySection(store: store, device: device)
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
                    .disabled(!store.filters.savableCriteria.isActive && smartAlbumQuery == nil)
                }
            }

            if let capturedDate = store.filters.capturedDate {
                Section("On This Day") {
                    LabeledContent("Captured", value: LibraryFilters.formatCapturedDate(capturedDate))
                    Button("Show All Dates", role: .destructive) {
                        store.applyFilters(store.filters.removing(.capturedDate))
                    }
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
                Section("Places") {
                    if options.countries.isEmpty, store.filters.country == nil {
                        Text("No places yet")
                            .foregroundStyle(.secondary)
                    } else {
                        NavigationLink {
                            PlaceFilterCategoryView(store: store)
                        } label: {
                            LabeledContent("Place", value: placeSummary)
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

    /// `Kyoto` with a city, `Japan` with only a country, `Anywhere` otherwise.
    private var placeSummary: String {
        store.filters.place?.name ?? store.filters.country?.name ?? "Anywhere"
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
        .accessibilityLabel(count.map { "\(text), \(CountText.photos($0))" } ?? text)
        .accessibilityAddTraits(selected ? .isSelected : [])
    }
}

/// Places category: "Anywhere", then countries with counts. Choosing a country applies it and
/// opens its cities; choosing a city (or "All of <country>") applies it and returns to Filter.
private struct PlaceFilterCategoryView<Store: FilterEditingStore>: View {
    @ObservedObject var store: Store
    @State private var search = ""
    @State private var openedCountry: PlaceCountryFilter?
    @Environment(\.dismiss) private var dismiss

    private var countries: [PlaceFilterOptions.Country] {
        PlaceFilterOptions.countries(store.filterOptions?.countries ?? [], active: store.filters.country)
    }

    private var filtered: [PlaceFilterOptions.Country] {
        let query = search.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !query.isEmpty else { return countries }
        return countries.filter {
            $0.filter.name.localizedCaseInsensitiveContains(query) || $0.filter.code.localizedCaseInsensitiveContains(query)
        }
    }

    var body: some View {
        List {
            Button {
                store.applyFilters(store.filters.selectingCountry(nil))
                dismiss()
            } label: {
                PlaceFilterRow(text: "Anywhere", count: nil, selected: store.filters.country == nil, disclosure: false)
            }
            ForEach(filtered) { country in
                Button {
                    store.applyFilters(store.filters.selectingCountry(country.filter))
                    openedCountry = country.filter
                } label: {
                    PlaceFilterRow(
                        text: country.filter.name,
                        count: country.count,
                        selected: store.filters.country?.code == country.filter.code,
                        disclosure: true
                    )
                }
            }
            if countries.isEmpty {
                Text("No places yet")
                    .foregroundStyle(.secondary)
            } else if filtered.isEmpty {
                Text("No matching countries")
                    .foregroundStyle(.secondary)
            }
        }
        .foregroundStyle(.primary)
        .navigationTitle("Places")
        .searchable(text: $search, prompt: "Search Countries")
        .navigationDestination(item: $openedCountry) { country in
            PlaceCityCategoryView(store: store, country: country) {
                openedCountry = nil
                dismiss()
            }
        }
    }
}

private struct PlaceCityCategoryView<Store: FilterEditingStore>: View {
    @ObservedObject var store: Store
    let country: PlaceCountryFilter
    /// Pops back to the Filter list once a choice is made.
    let finish: () -> Void
    @State private var search = ""

    private var cities: [PlaceFilterOptions.City] {
        PlaceFilterOptions.cities(
            store.filterOptions?.places ?? [],
            countryCode: country.code,
            active: store.filters.place
        )
    }

    private var filtered: [PlaceFilterOptions.City] {
        let query = search.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !query.isEmpty else { return cities }
        return cities.filter {
            $0.filter.name.localizedCaseInsensitiveContains(query)
                || ($0.filter.region?.localizedCaseInsensitiveContains(query) ?? false)
        }
    }

    var body: some View {
        List {
            Button {
                store.applyFilters(store.filters.selectingCountry(country).removing(.place))
                finish()
            } label: {
                PlaceFilterRow(
                    text: "All of \(country.name)",
                    count: nil,
                    selected: store.filters.country?.code == country.code && store.filters.place == nil,
                    disclosure: false
                )
            }
            ForEach(filtered) { city in
                Button {
                    store.applyFilters(store.filters.selectingCity(city.filter, in: country))
                    finish()
                } label: {
                    PlaceFilterRow(
                        text: city.filter.name,
                        detail: city.filter.region.flatMap { $0 == city.filter.name ? nil : $0 },
                        count: city.count,
                        selected: store.filters.place?.id == city.filter.id,
                        disclosure: false
                    )
                }
            }
            if cities.isEmpty {
                Text("No cities yet")
                    .foregroundStyle(.secondary)
            } else if filtered.isEmpty {
                Text("No matching cities")
                    .foregroundStyle(.secondary)
            }
        }
        .foregroundStyle(.primary)
        .navigationTitle(country.name)
        .searchable(text: $search, prompt: "Search Cities")
    }
}

private struct PlaceFilterRow: View {
    let text: String
    var detail: String?
    let count: Int?
    let selected: Bool
    let disclosure: Bool

    var body: some View {
        HStack {
            VStack(alignment: .leading, spacing: 2) {
                Text(text)
                if let detail {
                    Text(detail).font(.caption).foregroundStyle(.secondary)
                }
            }
            Spacer()
            if let count {
                Text(count.formatted())
                    .font(.callout.monospacedDigit())
                    .foregroundStyle(.secondary)
            }
            if selected { Image(systemName: "checkmark") }
            if disclosure {
                Image(systemName: "chevron.right")
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(.tertiary)
            }
        }
        .contentShape(Rectangle())
        .accessibilityElement(children: .combine)
        .accessibilityLabel(accessibilityText)
        .accessibilityAddTraits(selected ? .isSelected : [])
    }

    private var accessibilityText: String {
        let name = detail.map { "\(text), \($0)" } ?? text
        return count.map { "\(name), \(CountText.photos($0))" } ?? name
    }
}

/// Library Options › Show: All Photos, On This iPhone, or On Server, with what the device side
/// holds and why it may be empty.
private struct LibraryVisibilitySection: View {
    @ObservedObject var store: LibraryStore
    @ObservedObject var device: DeviceLibrary

    var body: some View {
        Section {
            let _ = device.revision
            if device.isAvailable {
                Picker("Show", selection: Binding(get: { device.visibility }, set: { store.setVisibility($0) })) {
                    ForEach(DeviceLibrary.Visibility.allCases) { visibility in
                        Text(visibility.title).tag(visibility)
                    }
                }
            } else if device.canRequestAccess {
                Button {
                    Task { await device.requestAccess() }
                } label: {
                    Label("Show Photos on This iPhone", systemImage: "iphone")
                }
            } else {
                Button {
                    if let url = URL(string: UIApplication.openSettingsURLString) {
                        UIApplication.shared.open(url)
                    }
                } label: {
                    Label("Allow Photos Access in Settings", systemImage: "photo.badge.exclamationmark")
                }
            }
        } header: {
            Text("Show")
        } footer: {
            if device.isAvailable {
                let deviceOnly = store.deviceOnlyCount
                Text(deviceOnly == 0
                    ? "Every photo on this iPhone is in your PhotoBrain library."
                    : "\(CountText.of(deviceOnly, "photo", "photos")) on this iPhone \(deviceOnly == 1 ? "isn’t" : "aren’t") on the server yet. Turn on Backup in Settings to add them.")
            }
        }
    }
}
