import Combine
import Foundation
import SwiftUI

struct LibraryFilters: Hashable, Sendable {
    /// `filterRaw` wire value: RAW stills, non-RAW stills, or videos (Live Photo motion clips
    /// excluded by the server); `.all` is everything.
    enum MediaKind: String, CaseIterable, Identifiable, Sendable {
        case all
        case raw
        case standard
        case video

        var id: Self { self }
        var title: String {
            switch self {
            case .all: "All Items"
            case .raw: "RAW"
            case .standard: "Standard"
            case .video: "Video"
            }
        }
    }

    var mediaKind: MediaKind = .all
    var camera: String?
    var lens: String?
    var iso: Int?
    var dateMonth: String?
    /// Minimum star rating, 1-5; `nil` means any rating.
    var minRating: Int?
    var flag: PhotoFlagFilter?
    /// Auto tag slug; `nil` means any tag.
    var tag: String?
    /// Country of the photos' place; `nil` means anywhere. Clearing it clears `place`.
    var country: PlaceCountryFilter?
    /// City of the photos' place, always inside `country` when both are set.
    var place: PlaceCityFilter?
    /// Map region the photos must lie in (Map's "Show N Photos"). A view scope, not saved
    /// criteria: smart albums never store it.
    var bounds: PhotoBounds?
    /// Exact capture date `YYYY-MM-DD` (an On this day card). A view scope, not saved
    /// criteria: smart albums never store it.
    var capturedDate: String?
    /// One auto event (an Events card). A view scope, not saved criteria: smart albums never
    /// store it.
    var event: EventFilter?

    enum Field: Hashable, Sendable {
        case mediaKind
        case camera
        case lens
        case iso
        case dateMonth
        case minRating
        case flag
        case tag
        case country
        case place
        case bounds
        case capturedDate
        case event
    }

    var isActive: Bool {
        mediaKind != .all || camera != nil || lens != nil || iso != nil || dateMonth != nil
            || minRating != nil || flag != nil || tag != nil || country != nil || place != nil || bounds != nil
            || capturedDate != nil || event != nil
    }

    struct ActiveFilter: Identifiable, Equatable, Sendable {
        let field: Field
        let title: String
        var id: Field { field }
    }

    /// Active filters in display order, each with its user-facing title.
    var activeFields: [ActiveFilter] {
        var fields: [ActiveFilter] = []
        if mediaKind != .all { fields.append(ActiveFilter(field: .mediaKind, title: mediaKind.title)) }
        if let camera { fields.append(ActiveFilter(field: .camera, title: camera)) }
        if let lens { fields.append(ActiveFilter(field: .lens, title: lens)) }
        if let iso { fields.append(ActiveFilter(field: .iso, title: "ISO \(iso)")) }
        if let dateMonth { fields.append(ActiveFilter(field: .dateMonth, title: Self.formatMonth(dateMonth))) }
        if let minRating { fields.append(ActiveFilter(field: .minRating, title: Self.formatMinRating(minRating))) }
        if let flag { fields.append(ActiveFilter(field: .flag, title: flag.title)) }
        if let tag { fields.append(ActiveFilter(field: .tag, title: PhotoTagName.hashtag(tag))) }
        if let country { fields.append(ActiveFilter(field: .country, title: country.name)) }
        if let place { fields.append(ActiveFilter(field: .place, title: place.name)) }
        if bounds != nil { fields.append(ActiveFilter(field: .bounds, title: "Map Area")) }
        if let capturedDate {
            fields.append(ActiveFilter(field: .capturedDate, title: Self.formatCapturedDate(capturedDate)))
        }
        if let event { fields.append(ActiveFilter(field: .event, title: event.title)) }
        return fields
    }

    var summary: String {
        let summary = activeFields.map(\.title).joined(separator: ", ")
        return summary.isEmpty ? "All Items" : summary
    }

    /// Wire representation shared by the library listing and filtered search.
    var photoQuery: PhotoQuery {
        PhotoQuery(
            filterRaw: mediaKind,
            folder: nil,
            camera: camera,
            lens: lens,
            iso: iso,
            dateMonth: dateMonth,
            minRating: minRating,
            flag: flag,
            tag: tag,
            country: country?.code,
            place: place?.id,
            bounds: bounds,
            capturedDate: capturedDate,
            event: event?.id
        )
    }

    func removing(_ field: Field) -> Self {
        var updated = self
        switch field {
        case .mediaKind: updated.mediaKind = .all
        case .camera: updated.camera = nil
        case .lens: updated.lens = nil
        case .iso: updated.iso = nil
        case .dateMonth: updated.dateMonth = nil
        case .minRating: updated.minRating = nil
        case .flag: updated.flag = nil
        case .tag: updated.tag = nil
        case .country:
            updated.country = nil
            updated.place = nil
        case .place: updated.place = nil
        case .bounds: updated.bounds = nil
        case .capturedDate: updated.capturedDate = nil
        case .event: updated.event = nil
        }
        return updated
    }

    mutating func clear() {
        self = LibraryFilters()
    }

    /// The filters a smart album can save: everything except the view scopes `bounds`,
    /// `capturedDate`, and `event`.
    var savableCriteria: Self {
        var criteria = self
        criteria.bounds = nil
        criteria.capturedDate = nil
        criteria.event = nil
        return criteria
    }

    /// Selects a country (or anywhere, for `nil`). A city outside the new country is cleared.
    func selectingCountry(_ country: PlaceCountryFilter?) -> Self {
        var updated = self
        updated.country = country
        if updated.place?.countryCode != country?.code { updated.place = nil }
        return updated
    }

    /// Selects a city together with the country it lies in.
    func selectingCity(_ city: PlaceCityFilter, in country: PlaceCountryFilter) -> Self {
        var updated = self
        updated.country = country
        updated.place = city
        return updated
    }

    /// Selects a photo's place: its city and that city's country.
    func selectingPlace(_ place: PhotoPlaceDTO) -> Self {
        selectingCity(
            PlaceCityFilter(id: place.id, name: place.city, region: place.region, countryCode: place.countryCode),
            in: PlaceCountryFilter(code: place.countryCode, name: place.country)
        )
    }

    static func formatMonth(_ value: String) -> String {
        let parts = value.replacingOccurrences(of: ":", with: "-").split(separator: "-")
        guard parts.count == 2,
              let year = Int(parts[0]),
              let month = Int(parts[1]),
              (1...12).contains(month) else { return value }
        return "\(PhotoDateResolver.calendar.monthSymbols[month - 1]) \(year)"
    }

    /// `2023-10-03` as `Oct 3, 2023` in `locale`; malformed values are returned unchanged.
    static func formatCapturedDate(_ value: String, locale: Locale = .autoupdatingCurrent) -> String {
        guard let date = OnThisDayDate.date(from: value) else { return value }
        return date.formatted(Date.FormatStyle(
            date: .abbreviated,
            time: .omitted,
            locale: locale,
            calendar: OnThisDayDate.utcCalendar,
            timeZone: OnThisDayDate.utcCalendar.timeZone
        ))
    }

    static func formatMinRating(_ stars: Int) -> String {
        "\(String(repeating: "★", count: stars))+"
    }
}

/// What a `LibraryStore` lists.
enum LibraryScope: Equatable, Sendable {
    /// The whole library, narrowed by the user's filters.
    case library
    /// One collection's members, narrowed by the user's filters.
    case collection(Int)
    /// Map "Show N Photos": the user's filters including their map region (`bounds`).
    /// Like other scoped screens it has no filter UI, so it loads no filter options.
    case mapArea
    /// One auto event's members (`filters.event`). Like other scoped screens it has no filter
    /// UI, so it loads no filter options.
    case event
    /// A smart album's saved criteria, evaluated live. The user's filters are not applied.
    case smartAlbum(filters: SmartAlbumFilters, query: String?)
    /// One person's photos (any face assigned to them), narrowed by the user's filters. Like
    /// other scoped screens it has no filter UI, so it loads no filter options.
    case person(Int)
}

extension LibraryScope {
    /// Query smart albums keep `POST /search`'s nearest-first ranking: their presentation is
    /// one unsorted section opened at the best match, never re-sorted by date.
    var isRanked: Bool {
        if case .smartAlbum(_, .some) = self { return true }
        return false
    }
}

/// The request that produces a `LibraryStore`'s photos.
enum PhotoListingSource: Equatable, Sendable {
    case photos(PhotoQuery)
    case search(query: String, limit: Int, filters: PhotoQuery)

    /// Query albums open with the largest result page `POST /search` accepts.
    static let smartAlbumSearchLimit = 100

    /// Filter-only albums list `GET /photos` with their filters; query albums run a semantic
    /// search with the query and the same filters.
    init(scope: LibraryScope, filters: LibraryFilters) {
        switch scope {
        case .library, .mapArea, .event:
            self = .photos(filters.photoQuery)
        case let .collection(id):
            var query = filters.photoQuery
            query.collectionId = id
            self = .photos(query)
        case let .person(id):
            var query = filters.photoQuery
            query.personId = id
            self = .photos(query)
        case let .smartAlbum(albumFilters, query):
            if let query {
                self = .search(query: query, limit: Self.smartAlbumSearchLimit, filters: albumFilters.photoQuery)
            } else {
                self = .photos(albumFilters.photoQuery)
            }
        }
    }

    func fetch(_ api: any PhotoBrainAPI) async throws -> [PhotoDTO] {
        switch self {
        case let .photos(query):
            try await api.photos(query: query).photos
        case let .search(query, limit, filters):
            try await api.search(query: query, limit: limit, filters: filters).photos
        }
    }
}

/// A store whose results are narrowed by `LibraryFilters`; drives the shared filter UI.
@MainActor
protocol FilterEditingStore: ObservableObject {
    var filters: LibraryFilters { get }
    var filterOptions: FilterOptionsDTO? { get }
    var filterOptionsError: String? { get }
    func applyFilters(_ filters: LibraryFilters)
    func retryFilterOptions() async
}

@MainActor
final class LibraryStore: ObservableObject, FilterEditingStore, CurationApplying, CollectionMembershipObserving {
    enum LoadState: Equatable {
        case idle
        case loading
        case content
        case empty
        case failed(String)
    }

    /// The server listing (curation overlaid).
    @Published private(set) var records: [PhotoRecord] = [] {
        didSet { cachedCaptureCalendar = nil }
    }
    /// Every cell in display order: server photos merged with this device's photos.
    @Published private(set) var orderedItems: [LibraryEntry] = []
    @Published private(set) var sections: [PhotoSection] = []
    @Published private(set) var filterOptions: FilterOptionsDTO?
    @Published private(set) var loadState: LoadState = .idle
    @Published private(set) var refreshError: String?
    @Published private(set) var filterOptionsError: String?
    @Published var filters = LibraryFilters()
    @Published var grouping: LibraryGrouping = .days
    @Published var sort: LibrarySort = .captured
    @Published var selectedItemIDs: Set<LibraryEntryID> = []
    @Published var isSelecting = false
    @Published var activeItemID: LibraryEntryID? {
        didSet {
            if activeItemID == nil, !pendingRemovalIDs.isEmpty { removeRecords(pendingRemovalIDs) }
        }
    }
    @Published var firstVisibleItemID: LibraryEntryID?
    @Published var isAtNewestEdge = true
    @Published var isBrowsingHistory = false
    @Published private(set) var presentationRevision = 0
    @Published private(set) var browsingResetVersion = 0

    let api: any PhotoBrainAPI
    let curation: PhotoCurationCenter
    /// What every listing covers; only the whole library loads filter options.
    let scope: LibraryScope
    /// The camera roll merged into the whole-library scope; nil elsewhere and when unavailable.
    let device: DeviceLibrary?
    private var loadTask: Task<Void, Never>?
    private var generation = 0
    private var recordsByID: [Int: PhotoRecord] = [:]
    private var itemsByID: [LibraryEntryID: LibraryEntry] = [:]
    /// Server photo id to the cell showing it (`.local` when the device has the asset).
    private var itemIDByPhotoID: [Int: LibraryEntryID] = [:]
    private var presentationGeneration = 0
    private var groupingBeforeSelection: LibraryGrouping?
    /// Photos removed from the scoped collection while the loupe is open; dropped on dismissal
    /// so the loupe never pages away underneath the membership sheet.
    private var pendingRemovalIDs: Set<Int> = []
    private var cachedCaptureCalendar: CaptureCalendar?
    private var deviceSubscription: AnyCancellable?

    init(
        api: any PhotoBrainAPI,
        curation: PhotoCurationCenter? = nil,
        scope: LibraryScope = .library,
        filters: LibraryFilters = LibraryFilters(),
        device: DeviceLibrary? = nil
    ) {
        self.api = api
        self.curation = curation ?? PhotoCurationCenter(api: api)
        self.scope = scope
        self.filters = filters
        self.device = scope == .library ? device : nil
        self.curation.register(self)
        deviceSubscription = self.device?.$revision
            .dropFirst()
            .removeDuplicates()
            .sink { [weak self] _ in
                Task { @MainActor in await self?.rebuildPresentation() }
            }
    }

    /// The scoped collection, if this store lists one collection's members.
    var collectionId: Int? {
        guard case let .collection(id) = scope else { return nil }
        return id
    }

    /// Server photos in display order (device-only cells omitted).
    var orderedRecords: [PhotoRecord] { orderedItems.compactMap(\.remote) }

    /// Server photo of the open cell; nil for a device-only photo.
    var activePhotoID: Int? {
        get { activeItemID.flatMap { itemsByID[$0]?.remote?.id ?? $0.remotePhotoID } }
        set { activeItemID = newValue.map { itemIDByPhotoID[$0] ?? .remote($0) } }
    }

    /// Server photos among the selection, in no particular order.
    var selectedPhotoIDs: Set<Int> {
        Set(selectedItemIDs.compactMap { itemsByID[$0]?.remote?.id ?? $0.remotePhotoID })
    }

    func item(_ id: LibraryEntryID) -> LibraryEntry? { itemsByID[id] }

    /// EXIF capture-day counts over the loaded (filtered) records, built once per records change.
    var captureCalendar: CaptureCalendar {
        if let cachedCaptureCalendar { return cachedCaptureCalendar }
        let calendar = CaptureCalendar(records: records)
        cachedCaptureCalendar = calendar
        return calendar
    }


    var visibleDateText: String {
        guard !isSelecting,
              isBrowsingHistory,
              let id = firstVisibleItemID,
              let item = itemsByID[id] else { return "" }
        return item.captureDate.formatted(
            Date.FormatStyle(timeZone: PhotoDateResolver.calendar.timeZone).year().month(.wide).day()
        )
    }

    /// `21 Items`; stable while scrolling (pinned section headers show the visible date), so
    /// the navigation bar never resizes mid-scroll.
    var itemCountText: String {
        Self.countText(orderedItems.count)
    }

    var headerSubtitle: String {
        if isSelecting {
            switch selectedItemIDs.count {
            case 0: return "Select Items"
            case 1: return "1 Selected"
            default: return "\(selectedItemIDs.count.formatted()) Selected"
            }
        }
        if !visibleDateText.isEmpty { return visibleDateText }
        return itemCountText
    }

    /// Device-only cells shown (not yet on the server).
    var deviceOnlyCount: Int { orderedItems.lazy.filter(\.isDeviceOnly).count }

    private static func countText(_ count: Int) -> String {
        count == 1 ? "1 Item" : "\(count.formatted()) Items"
    }

    /// Day key (`YYYY-MM-DD`) to the title of the auto event covering it; names day sections.
    private(set) var eventTitlesByDay: [String: String] = [:]

    /// Names day sections after events; rebuilds only when the titles change.
    func setEventTitles(_ titles: [String: String]) async {
        guard titles != eventTitlesByDay else { return }
        eventTitlesByDay = titles
        guard grouping == .days else { return }
        await rebuildPresentation()
    }

    func load(retainingContent: Bool = true) async {
        generation += 1
        let requestGeneration = generation
        let previousOrderedIDs = orderedItems.map(\.id)
        loadTask?.cancel()
        if orderedItems.isEmpty || !retainingContent {
            loadState = .loading
        }
        refreshError = nil
        let source = PhotoListingSource(scope: scope, filters: filters)
        // Filter metadata is library-wide; scoped screens have no filter UI to feed.
        let loadsFilterOptions = scope == .library
        let task = Task { [api, device] in
            let photosTask = Task { try await source.fetch(api) }
            let optionsTask = loadsFilterOptions ? Task { try await api.filterOptions(folder: nil) } : nil
            let deviceTask = device.map { device in Task { await device.reload() } }
            defer {
                photosTask.cancel()
                optionsTask?.cancel()
            }

            do {
                let photos = try await photosTask.value
                await deviceTask?.value
                guard !Task.isCancelled, requestGeneration == generation else { return }
                pendingRemovalIDs.removeAll()
                records = curation.overlay(photos.map { PhotoRecord(dto: $0, apiBaseURL: api.baseURL) })
                recordsByID.removeAll(keepingCapacity: true)
                for photo in records {
                    recordsByID[photo.id] = photo
                }
                await rebuildPresentation()
                guard !Task.isCancelled, requestGeneration == generation else { return }
                selectedItemIDs.formIntersection(orderedItems.map(\.id))
                let anchored = PhotoIDAnchor.resolve(
                    previousID: activeItemID,
                    previousOrderedIDs: previousOrderedIDs,
                    nextOrderedIDs: orderedItems.map(\.id)
                )
                if activeItemID != nil { activeItemID = anchored }
                loadState = orderedItems.isEmpty ? .empty : .content
            } catch is CancellationError {
                return
            } catch {
                await deviceTask?.value
                guard requestGeneration == generation else { return }
                let message = (error as? LocalizedError)?.errorDescription ?? error.localizedDescription
                if scope == .library, !filters.isActive, records.isEmpty {
                    records = await SmartPreviewCache.shared.cachedPhotos(origin: api.baseURL)
                    recordsByID = Dictionary(uniqueKeysWithValues: records.map { ($0.id, $0) })
                    await rebuildPresentation()
                    if !records.isEmpty { refreshError = "Offline RAW previews" }
                }
                // Offline: the device's photos still show.
                if orderedItems.isEmpty, records.isEmpty, device?.assets.isEmpty == false {
                    await rebuildPresentation()
                }
                if orderedItems.isEmpty {
                    loadState = .failed(message)
                } else {
                    loadState = .content
                    refreshError = refreshError ?? message
                }
            }

            guard let optionsTask else { return }
            do {
                let options = try await optionsTask.value
                guard !Task.isCancelled, requestGeneration == generation else { return }
                filterOptions = options
                filterOptionsError = nil
            } catch is CancellationError {
                return
            } catch {
                guard requestGeneration == generation else { return }
                filterOptionsError = (error as? LocalizedError)?.errorDescription ?? error.localizedDescription
            }
        }
        loadTask = task
        await task.value
    }

    /// Keeps a collection-scoped listing in sync with membership edits made anywhere in the app.
    func collectionMembershipChanged(collectionId: Int, photoIds: [Int], isMember: Bool) {
        guard let scopedID = self.collectionId, collectionId == scopedID else { return }
        if isMember {
            pendingRemovalIDs.subtract(photoIds)
            if photoIds.contains(where: { recordsByID[$0] == nil }) {
                Task { await load() }
            }
        } else if activeItemID == nil {
            removeRecords(Set(photoIds))
        } else {
            pendingRemovalIDs.formUnion(photoIds.filter { recordsByID[$0] != nil })
        }
    }

    private func removeRecords(_ ids: Set<Int>) {
        pendingRemovalIDs.subtract(ids)
        guard ids.contains(where: { recordsByID[$0] != nil }) else { return }
        let itemIDs = Set(ids.compactMap { itemIDByPhotoID[$0] })
        records.removeAll { ids.contains($0.id) }
        for id in ids {
            recordsByID[id] = nil
            itemIDByPhotoID[id] = nil
        }
        for id in itemIDs { itemsByID[id] = nil }
        selectedItemIDs.subtract(itemIDs)
        orderedItems.removeAll { itemIDs.contains($0.id) }
        for index in sections.indices {
            sections[index].items.removeAll { itemIDs.contains($0.id) }
        }
        sections.removeAll { $0.items.isEmpty }
        presentationRevision &+= 1
        if case .content = loadState, orderedItems.isEmpty { loadState = .empty }
    }

    /// Patches one record in place (records, lookup, ordered list, and its section) and bumps
    /// the presentation revision so the grid reconfigures only that cell; no reload or re-sort.
    func applyCuration(id: Int, curation: PhotoCuration) {
        guard let existing = recordsByID[id],
              existing.rating != curation.rating || existing.flag != curation.flag else { return }
        var updated = existing
        updated.rating = curation.rating
        updated.flag = curation.flag
        recordsByID[id] = updated
        if let index = records.firstIndex(where: { $0.id == id }) {
            records[index] = updated
        }
        if let itemID = itemIDByPhotoID[id], var item = itemsByID[itemID] {
            item.remote = updated
            itemsByID[itemID] = item
            if let index = orderedItems.firstIndex(where: { $0.id == itemID }) {
                orderedItems[index] = item
            }
            for sectionIndex in sections.indices {
                if let index = sections[sectionIndex].items.firstIndex(where: { $0.id == itemID }) {
                    sections[sectionIndex].items[index] = item
                    break
                }
            }
        }
        presentationRevision &+= 1
    }

    func applyFlag(id: Int, flag: PhotoFlag?) {
        guard let existing = recordsByID[id] else { return }
        applyCuration(id: id, curation: PhotoCuration(rating: existing.rating, flag: flag))
    }

    func retryFilterOptions() async {
        filterOptionsError = nil
        do {
            filterOptions = try await api.filterOptions(folder: nil)
        } catch {
            filterOptionsError = (error as? LocalizedError)?.errorDescription ?? error.localizedDescription
        }
    }

    func applyFilters(_ filters: LibraryFilters) {
        finishSelection(restoringGrouping: true)
        self.filters = filters
        resetBrowsingContext()
        Task { await load() }
    }

    /// Library Options › Show: which sources the Library lists.
    func setVisibility(_ visibility: DeviceLibrary.Visibility) {
        guard let device, device.visibility != visibility else { return }
        device.visibility = visibility
        resetBrowsingContext()
    }

    func setSort(_ sort: LibrarySort) async {
        self.sort = sort
        if sort == .added { grouping = .all }
        resetBrowsingContext()
        await rebuildPresentation()
    }
    func setGrouping(_ grouping: LibraryGrouping) async {
        guard self.grouping != grouping else { return }
        self.grouping = grouping
        if grouping != .all { sort = .captured }
        // Time grouping is a zoom through this date, not a new browsing context.
        await rebuildPresentation()
    }

    func beginSelection() {
        if !isSelecting { groupingBeforeSelection = grouping }
        isSelecting = true
        selectedItemIDs.removeAll()
    }

    func endSelection() {
        finishSelection(restoringGrouping: true)
    }

    func activate(_ id: LibraryEntryID) {
        if isSelecting {
            if selectedItemIDs.contains(id) {
                selectedItemIDs.remove(id)
            } else {
                selectedItemIDs.insert(id)
            }
        } else {
            activeItemID = id
        }
    }

    /// Server-photo convenience for callers and tests that know only photo ids.
    func activate(_ photoID: Int) {
        activate(itemIDByPhotoID[photoID] ?? .remote(photoID))
    }

    func selectFromLongPress(_ id: LibraryEntryID) {
        if !isSelecting { beginSelection() }
        selectedItemIDs.insert(id)
    }

    func clearFilters() {
        applyFilters(LibraryFilters())
    }

    /// On this day card action: narrows the library to one capture date, then reloads.
    func showCapturedDate(_ capturedDate: String) {
        var updated = filters
        updated.capturedDate = capturedDate
        applyFilters(updated)
    }

    /// Loupe tag-chip action: closes this store's loupe and narrows the library to `tag`,
    /// keeping the other active filters, then reloads.
    func showTag(_ tag: String) {
        activeItemID = nil
        var updated = filters
        updated.tag = tag
        applyFilters(updated)
    }

    /// Loupe place-row action: closes this store's loupe and narrows the library to the
    /// place's city (and its country), keeping the other active filters, then reloads.
    func showPlace(_ place: PhotoPlaceDTO) {
        activeItemID = nil
        applyFilters(filters.selectingPlace(place))
    }

    func show(_ shortcut: LibraryShortcut) {
        switch shortcut {
        case let .tag(tag): showTag(tag)
        case let .place(place): showPlace(place)
        case let .capturedDate(date):
            activeItemID = nil
            showCapturedDate(date)
        case let .gear(selection):
            activeItemID = nil
            showGear(selection)
        }
    }

    func observeVisible(firstID: LibraryEntryID?, distanceFromNewest: CGFloat) {
        let atNewest = distanceFromNewest <= 2
        let browsingHistory = distanceFromNewest >= 24
        if firstVisibleItemID != firstID { firstVisibleItemID = firstID }
        if isAtNewestEdge != atNewest { isAtNewestEdge = atNewest }
        if isBrowsingHistory != browsingHistory { isBrowsingHistory = browsingHistory }
    }

    /// Server-photo convenience for tests.
    func observeVisible(firstID: Int?, distanceFromNewest: CGFloat) {
        observeVisible(firstID: firstID.map { itemIDByPhotoID[$0] ?? .remote($0) }, distanceFromNewest: distanceFromNewest)
    }

    private func finishSelection(restoringGrouping: Bool) {
        isSelecting = false
        selectedItemIDs.removeAll()
        defer { groupingBeforeSelection = nil }
        guard restoringGrouping,
              let prior = groupingBeforeSelection,
              prior != grouping else { return }
        grouping = prior
        if prior != .all { sort = .captured }
        resetBrowsingContext()
        Task { await rebuildPresentation() }
    }

    /// The cells to present: server photos, merged with this device's photos in the Library.
    private func mergedItems() -> [LibraryEntry] {
        guard let device, device.isAvailable, !device.assets.isEmpty else {
            return records.map(LibraryEntry.init(remote:))
        }
        let merged = LibraryMerge.merge(
            remote: records,
            assets: device.assets,
            photoIDsByAsset: device.photoIDsByAsset,
            filters: filters,
            includeDeviceOnly: device.visibility != .server,
            backupState: { device.backupState(assetId: $0) }
        )
        switch device.visibility {
        case .all: return merged
        case .device: return merged.filter { $0.local != nil }
        case .server: return merged.filter { $0.remote != nil }
        }
    }

    private func rebuildPresentation() async {
        presentationGeneration += 1
        let requestedGeneration = presentationGeneration
        let items = mergedItems()
        let sort = sort
        let grouping = grouping
        let ranked = scope.isRanked
        let eventTitles = eventTitlesByDay
        let presentation = await Task.detached(priority: .userInitiated) {
            let signpost = SpikeSignposts.beginCapturedPresentation(
                recordCount: items.count,
                grouping: grouping,
                sort: sort
            )
            let presentation = ranked
                ? LibraryPresentationBuilder.ranked(items: items)
                : LibraryPresentationBuilder.build(
                    items: items,
                    sort: sort,
                    grouping: grouping,
                    eventTitles: eventTitles
                )
            SpikeSignposts.endCapturedPresentation(
                signpost,
                recordCount: items.count,
                sectionCount: presentation.sections.count
            )
            return presentation
        }.value
        guard requestedGeneration == presentationGeneration else { return }
        let previousOrderedIDs = orderedItems.map(\.id)
        orderedItems = presentation.ordered
        sections = presentation.sections
        itemsByID.removeAll(keepingCapacity: true)
        itemIDByPhotoID.removeAll(keepingCapacity: true)
        for item in orderedItems {
            itemsByID[item.id] = item
            if let photoID = item.remote?.id { itemIDByPhotoID[photoID] = item.id }
        }
        if let active = activeItemID, itemsByID[active] == nil {
            activeItemID = PhotoIDAnchor.resolve(
                previousID: active,
                previousOrderedIDs: previousOrderedIDs,
                nextOrderedIDs: orderedItems.map(\.id)
            )
        }
        selectedItemIDs.formIntersection(itemsByID.keys)
        if case .empty = loadState, !orderedItems.isEmpty { loadState = .content }
        presentationRevision &+= 1
    }

    private func resetBrowsingContext() {
        firstVisibleItemID = nil
        isAtNewestEdge = true
        isBrowsingHistory = false
        browsingResetVersion += 1
    }
}

enum LibraryPresentationBuilder {
    private struct CapturedItem {
        let item: LibraryEntry
        let date: Date
    }

    /// Server-record convenience (tests, other callers): every record as a remote cell.
    static func build(
        records: [PhotoRecord],
        sort: LibrarySort,
        grouping: LibraryGrouping,
        eventTitles: [String: String] = [:]
    ) -> (ordered: [LibraryEntry], sections: [PhotoSection]) {
        build(items: records.map(LibraryEntry.init(remote:)), sort: sort, grouping: grouping, eventTitles: eventTitles)
    }

    /// Recently Added orders server photos by id; device-only photos have no server id yet and
    /// come last, newest first by capture date.
    private static func addedOrder(_ left: LibraryEntry, _ right: LibraryEntry) -> Bool {
        switch (left.remote?.id, right.remote?.id) {
        case let (l?, r?): return l < r
        case (.some, nil): return true
        case (nil, .some): return false
        case (nil, nil):
            return left.captureDate == right.captureDate ? left.id < right.id : left.captureDate < right.captureDate
        }
    }

    static func build(
        items: [LibraryEntry],
        sort: LibrarySort,
        grouping: LibraryGrouping,
        eventTitles: [String: String] = [:]
    ) -> (ordered: [LibraryEntry], sections: [PhotoSection]) {
        if sort == .added {
            let ordered = items.sorted(by: addedOrder)
            return (ordered, [allSection(ordered)])
        }

        var captured: [CapturedItem] = []
        captured.reserveCapacity(items.count)
        for item in items {
            captured.append(CapturedItem(item: item, date: item.captureDate))
        }
        captured.sort { left, right in
            if left.date == right.date {
                return left.item.id < right.item.id
            }
            return left.date < right.date
        }
        var ordered: [LibraryEntry] = []
        ordered.reserveCapacity(captured.count)
        for entry in captured {
            ordered.append(entry.item)
        }
        guard grouping != .all else {
            return (ordered, [allSection(ordered)])
        }
        if grouping == .days {
            return (ordered, daySections(captured, eventTitles: eventTitles))
        }

        let monthSymbols = grouping == .months ? PhotoDateResolver.calendar.monthSymbols : []
        var sections: [PhotoSection] = []
        var currentID: PhotoSection.ID?
        var currentTitle = ""
        var currentItems: [LibraryEntry] = []

        for entry in captured {
            let components = PhotoDateResolver.calendar.dateComponents(
                [.year, .month],
                from: entry.date
            )
            let year = components.year ?? 1
            let month = grouping == .years ? 0 : (components.month ?? 1)
            let id = PhotoSection.ID(
                year: year,
                month: month,
                discriminator: grouping.rawValue
            )
            if id != currentID {
                if let currentID {
                    sections.append(
                        PhotoSection(id: currentID, title: currentTitle, items: currentItems)
                    )
                }
                currentID = id
                currentTitle = grouping == .years
                    ? String(year)
                    : "\(monthSymbols[max(0, min(11, month - 1))]) \(year)"
                currentItems = []
            }
            currentItems.append(entry.item)
        }

        if let currentID {
            sections.append(
                PhotoSection(id: currentID, title: currentTitle, items: currentItems)
            )
        }
        return (ordered, sections)
    }

    /// Moments: each day an auto event covers becomes its own section titled with the event's
    /// place (detail `May 18, 2024 · 6`); runs of other days collapse into month sections
    /// (`May 2024`, detail `9`). Dates use the GMT capture calendar like every capture date.
    private static func daySections(
        _ captured: [CapturedItem],
        eventTitles: [String: String]
    ) -> [PhotoSection] {
        let calendar = PhotoDateResolver.calendar
        let dateStyle = Date.FormatStyle(date: .abbreviated, time: .omitted, timeZone: calendar.timeZone)
        let monthSymbols = calendar.monthSymbols
        var sections: [PhotoSection] = []
        var currentID: PhotoSection.ID?
        var currentTitle = ""
        var currentDetailPrefix: String?
        var currentItems: [LibraryEntry] = []

        func flush() {
            guard let currentID else { return }
            let count = currentItems.count.formatted()
            let detail = currentDetailPrefix.map { "\($0) · \(count)" } ?? count
            sections.append(PhotoSection(id: currentID, title: currentTitle, items: currentItems, detail: detail))
        }

        for entry in captured {
            let parts = calendar.dateComponents([.year, .month, .day], from: entry.date)
            let year = parts.year ?? 1, month = parts.month ?? 1, day = parts.day ?? 1
            let key = EventDayIndex.key(year: year, month: month, day: day)
            let id: PhotoSection.ID
            let title: String
            let prefix: String?
            if let event = eventTitles[key] {
                id = PhotoSection.ID(year: year, month: month, discriminator: "event-\(day)")
                title = event
                prefix = entry.date.formatted(dateStyle)
            } else {
                id = PhotoSection.ID(year: year, month: month, discriminator: "month-after-\(sections.count)")
                title = "\(monthSymbols[max(0, min(11, month - 1))]) \(year)"
                prefix = nil
            }
            // Consecutive non-event photos in one month share a section regardless of the
            // section count in their discriminator.
            let continues = currentID.map { current in
                current.year == id.year && current.month == id.month
                    && (current.discriminator == id.discriminator
                        || (current.discriminator.hasPrefix("month-") && id.discriminator.hasPrefix("month-")))
            } ?? false
            if !continues {
                flush()
                currentID = id
                currentTitle = title
                currentDetailPrefix = prefix
                currentItems = []
            }
            currentItems.append(entry.item)
        }
        flush()
        return sections
    }

    /// Server order unchanged, as one section.
    static func ranked(_ records: [PhotoRecord]) -> (ordered: [LibraryEntry], sections: [PhotoSection]) {
        ranked(items: records.map(LibraryEntry.init(remote:)))
    }

    static func ranked(items: [LibraryEntry]) -> (ordered: [LibraryEntry], sections: [PhotoSection]) {
        (items, [allSection(items)])
    }

    private static func allSection(_ ordered: [LibraryEntry]) -> PhotoSection {
        PhotoSection(
            id: .init(year: 0, month: 0, discriminator: "all"),
            title: "",
            items: ordered
        )
    }
}

@MainActor
final class SearchStore: ObservableObject, FilterEditingStore, CurationApplying {
    enum State: Equatable {
        case idle
        case waiting
        case loading
        case results
        case empty
        case failed(String)
    }

    static let resultLimit = 50

    /// True when results come from filters alone, not a text query.
    var isBrowsingFilters: Bool {
        query.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && filters.isActive
    }

    private static func newestFirst(_ photos: [PhotoDTO]) -> [PhotoDTO] {
        photos.reversed()
    }

    /// Opens Search filtered to a Library shortcut (tag, place, date, or gear), replacing the
    /// query and any previous filters.
    func show(_ shortcut: LibraryShortcut) {
        activePhotoID = nil
        query = ""
        var updated = LibraryFilters()
        switch shortcut {
        case let .tag(tag): updated.tag = tag
        case let .place(place): updated = updated.selectingPlace(place)
        case let .capturedDate(date): updated.capturedDate = date
        case let .gear(.camera(camera)): updated.camera = camera
        case let .gear(.lens(lens)): updated.lens = lens
        }
        applyFilters(updated)
    }

    @Published var query = "" {
        didSet { schedule() }
    }
    @Published private(set) var filters = LibraryFilters()
    @Published private(set) var filterOptions: FilterOptionsDTO?
    @Published private(set) var filterOptionsError: String?
    @Published private(set) var state: State = .idle
    @Published private(set) var records: [PhotoRecord] = []
    @Published var activePhotoID: Int?

    private let api: any PhotoBrainAPI
    let curation: PhotoCurationCenter
    private var task: Task<Void, Never>?
    private var optionsTask: Task<Void, Never>?
    /// Bumped for every new (query, filters) request; responses from older generations are dropped.
    private var generation = 0

    init(api: any PhotoBrainAPI, curation: PhotoCurationCenter? = nil) {
        self.api = api
        self.curation = curation ?? PhotoCurationCenter(api: api)
        self.curation.register(self)
    }

    func applyCuration(id: Int, curation: PhotoCuration) {
        records.applyCuration(id: id, curation: curation)
    }

    func applyFlag(id: Int, flag: PhotoFlag?) {
        records.applyFlag(id: id, flag: flag)
    }

    func retry() {
        schedule(immediate: true)
    }

    func clear() {
        query = ""
    }

    /// Filters are part of the request identity: a change supersedes any in-flight search
    /// for the previous combination and re-runs the current query immediately.
    func applyFilters(_ filters: LibraryFilters) {
        guard filters != self.filters else { return }
        self.filters = filters
        schedule(immediate: true)
    }

    func clearFilters() {
        applyFilters(LibraryFilters())
    }

    /// Loads filter options the first time the filter UI is shown.
    func loadFilterOptionsIfNeeded() async {
        guard filterOptions == nil else { return }
        await retryFilterOptions()
    }

    /// Fetches library-wide filter options (the same scope the Library filter UI uses).
    func retryFilterOptions() async {
        if let optionsTask { return await optionsTask.value }
        filterOptionsError = nil
        let task = Task { [api] in
            do {
                filterOptions = try await api.filterOptions(folder: nil)
            } catch is CancellationError {
                return
            } catch {
                filterOptionsError = (error as? LocalizedError)?.errorDescription ?? error.localizedDescription
            }
        }
        optionsTask = task
        await task.value
        optionsTask = nil
    }

    private func schedule(immediate: Bool = false) {
        generation += 1
        let currentGeneration = generation
        task?.cancel()
        let trimmed = query.trimmingCharacters(in: .whitespacesAndNewlines)
        // Browse mode: with no text, active filters list matching photos (newest first),
        // the way Photos narrows search by camera, place, or category without a query.
        guard !trimmed.isEmpty || filters.isActive else {
            task = nil
            records = []
            state = .idle
            return
        }
        let request = filters.photoQuery
        let browsing = trimmed.isEmpty
        state = immediate || browsing ? .loading : .waiting
        task = Task { [api] in
            do {
                if !immediate, !browsing {
                    try await Task.sleep(for: .milliseconds(350))
                }
                guard !Task.isCancelled, currentGeneration == generation else { return }
                state = .loading
                let photos = browsing
                    ? Self.newestFirst(try await api.photos(query: request).photos)
                    : try await api.search(query: trimmed, limit: Self.resultLimit, filters: request).photos
                guard !Task.isCancelled, currentGeneration == generation else { return }
                records = curation.overlay(photos.map { PhotoRecord(dto: $0, apiBaseURL: api.baseURL) })
                state = records.isEmpty ? .empty : .results
            } catch is CancellationError {
                return
            } catch {
                guard currentGeneration == generation else { return }
                records = []
                state = .failed((error as? LocalizedError)?.errorDescription ?? error.localizedDescription)
            }
        }
    }
}

@MainActor
final class SimilarPhotosStore: ObservableObject, CurationApplying {
    enum State: Equatable {
        case idle
        case loading
        case loaded
        case empty
        case notIndexed
        case failed(String)
    }

    static let resultLimit = 30

    @Published private(set) var state: State = .idle
    @Published private(set) var records: [PhotoRecord] = []
    @Published private(set) var sourcePhotoID: Int?
    @Published var activePhotoID: Int?

    private let api: any PhotoBrainAPI
    let curation: PhotoCurationCenter
    private var task: Task<Void, Never>?
    private var generation = 0

    init(api: any PhotoBrainAPI, curation: PhotoCurationCenter? = nil) {
        self.api = api
        self.curation = curation ?? PhotoCurationCenter(api: api)
        self.curation.register(self)
    }

    func applyCuration(id: Int, curation: PhotoCuration) {
        records.applyCuration(id: id, curation: curation)
    }

    func applyFlag(id: Int, flag: PhotoFlag?) {
        records.applyFlag(id: id, flag: flag)
    }

    /// Starts loading neighbours for `sourceID` unless that source already has a settled result.
    /// A different source supersedes any in-flight request; its late response is discarded.
    @discardableResult
    func load(sourceID: Int) -> Task<Void, Never>? {
        if sourceID == sourcePhotoID {
            switch state {
            case .loading: return task
            case .loaded, .empty, .notIndexed: return nil
            case .idle, .failed: break
            }
        }
        return fetch(sourceID: sourceID)
    }

    @discardableResult
    func retry() -> Task<Void, Never>? {
        guard let sourcePhotoID else { return nil }
        return fetch(sourceID: sourcePhotoID)
    }

    /// Cancels the in-flight request (e.g. when the screen disappears). An interrupted load returns
    /// to `.idle` so the next `load(sourceID:)` refetches; settled results are retained.
    func cancel() {
        generation += 1
        task?.cancel()
        task = nil
        if state == .loading { state = .idle }
    }

    private func fetch(sourceID: Int) -> Task<Void, Never> {
        generation += 1
        let currentGeneration = generation
        task?.cancel()
        if sourceID != sourcePhotoID {
            sourcePhotoID = sourceID
            records = []
            activePhotoID = nil
        }
        state = .loading
        let task = Task { [api] in
            do {
                let response = try await api.similarPhotos(id: sourceID, limit: Self.resultLimit, event: nil)
                guard !Task.isCancelled, currentGeneration == generation else { return }
                guard response.indexed else {
                    records = []
                    state = .notIndexed
                    return
                }
                records = curation.overlay(response.photos.map { PhotoRecord(dto: $0, apiBaseURL: api.baseURL) })
                state = records.isEmpty ? .empty : .loaded
            } catch is CancellationError {
                return
            } catch {
                guard !Task.isCancelled, currentGeneration == generation else { return }
                records = []
                state = .failed((error as? LocalizedError)?.errorDescription ?? error.localizedDescription)
            }
        }
        self.task = task
        return task
    }
}

extension Array where Element == PhotoRecord {
    /// Replaces one record's curation in place; a no-op when absent or unchanged.
    mutating func applyCuration(id: Int, curation: PhotoCuration) {
        guard let index = firstIndex(where: { $0.id == id }),
              self[index].rating != curation.rating || self[index].flag != curation.flag else { return }
        self[index].rating = curation.rating
        self[index].flag = curation.flag
    }

    /// Replaces one record's flag in place, keeping its rating; a no-op when absent or unchanged.
    mutating func applyFlag(id: Int, flag: PhotoFlag?) {
        guard let index = firstIndex(where: { $0.id == id }), self[index].flag != flag else { return }
        self[index].flag = flag
    }
}
