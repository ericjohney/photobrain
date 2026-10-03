import Foundation
import SwiftUI

struct LibraryFilters: Equatable, Sendable {
    enum MediaKind: String, CaseIterable, Identifiable, Sendable {
        case all
        case raw
        case standard

        var id: Self { self }
        var title: String {
            switch self {
            case .all: "All Items"
            case .raw: "RAW"
            case .standard: "Standard"
            }
        }
    }

    var mediaKind: MediaKind = .all
    var camera: String?
    var lens: String?
    var iso: Int?
    var dateMonth: String?

    var isActive: Bool {
        mediaKind != .all || camera != nil || lens != nil || iso != nil || dateMonth != nil
    }

    var summary: String {
        let values: [String?] = [
            mediaKind == .all ? nil : mediaKind.title,
            camera,
            lens,
            iso.map { "ISO \($0)" },
            dateMonth.map(Self.formatMonth),
        ]
        let summary = values.compactMap { $0 }.joined(separator: ", ")
        return summary.isEmpty ? "All Items" : summary
    }

    mutating func clear() {
        self = LibraryFilters()
    }

    static func formatMonth(_ value: String) -> String {
        let parts = value.replacingOccurrences(of: ":", with: "-").split(separator: "-")
        guard parts.count == 2,
              let year = Int(parts[0]),
              let month = Int(parts[1]),
              (1...12).contains(month) else { return value }
        return "\(PhotoDateResolver.calendar.monthSymbols[month - 1]) \(year)"
    }
}

@MainActor
final class LibraryStore: ObservableObject {
    enum LoadState: Equatable {
        case idle
        case loading
        case content
        case empty
        case failed(String)
    }

    @Published private(set) var records: [PhotoRecord] = []
    @Published private(set) var orderedRecords: [PhotoRecord] = []
    @Published private(set) var sections: [PhotoSection] = []
    @Published private(set) var filterOptions: FilterOptionsDTO?
    @Published private(set) var loadState: LoadState = .idle
    @Published private(set) var refreshError: String?
    @Published private(set) var filterOptionsError: String?
    @Published var filters = LibraryFilters()
    @Published var grouping: LibraryGrouping = .all
    @Published var sort: LibrarySort = .captured
    @Published var selectedPhotoIDs: Set<Int> = []
    @Published var isSelecting = false
    @Published var activePhotoID: Int?
    @Published var firstVisiblePhotoID: Int?
    @Published var isAtNewestEdge = true
    @Published var isBrowsingHistory = false
    @Published private(set) var presentationRevision = 0
    @Published private(set) var browsingResetVersion = 0

    let api: any PhotoBrainAPI
    private var loadTask: Task<Void, Never>?
    private var generation = 0
    private var recordsByID: [Int: PhotoRecord] = [:]
    private var presentationGeneration = 0
    private var groupingBeforeSelection: LibraryGrouping?

    init(api: any PhotoBrainAPI) {
        self.api = api
    }


    var visibleDateText: String {
        guard !isSelecting,
              isBrowsingHistory,
              let id = firstVisiblePhotoID,
              let photo = recordsByID[id] else { return "" }
        return PhotoDateResolver.date(for: photo).formatted(.dateTime.year().month(.wide).day())
    }

    var headerSubtitle: String {
        if isSelecting {
            switch selectedPhotoIDs.count {
            case 0: return "Select Items"
            case 1: return "1 Selected"
            default: return "\(selectedPhotoIDs.count.formatted()) Selected"
            }
        }
        if !visibleDateText.isEmpty { return visibleDateText }
        return records.count == 1 ? "1 Item" : "\(records.count.formatted()) Items"
    }

    var showsCollapsedHistoryControls: Bool {
        !records.isEmpty && !isSelecting && (isBrowsingHistory || grouping != .all)
    }

    func load(retainingContent: Bool = true) async {
        generation += 1
        let requestGeneration = generation
        let previousOrderedIDs = orderedRecords.map(\.id)
        loadTask?.cancel()
        if records.isEmpty || !retainingContent {
            loadState = .loading
        }
        refreshError = nil
        let query = PhotoQuery(
            filterRaw: filters.mediaKind,
            folder: nil,
            camera: filters.camera,
            lens: filters.lens,
            iso: filters.iso,
            dateMonth: filters.dateMonth
        )
        let task = Task { [api] in
            let photosTask = Task { try await api.photos(query: query) }
            let optionsTask = Task { try await api.filterOptions(folder: nil) }
            defer {
                photosTask.cancel()
                optionsTask.cancel()
            }

            do {
                let photos = try await photosTask.value
                guard !Task.isCancelled, requestGeneration == generation else { return }
                records = photos.photos.map { PhotoRecord(dto: $0, apiBaseURL: api.baseURL) }
                recordsByID.removeAll(keepingCapacity: true)
                for photo in records {
                    recordsByID[photo.id] = photo
                }
                await rebuildPresentation()
                guard !Task.isCancelled, requestGeneration == generation else { return }
                selectedPhotoIDs.formIntersection(records.map(\.id))
                let anchored = PhotoIDAnchor.resolve(
                    previousID: activePhotoID,
                    previousOrderedIDs: previousOrderedIDs,
                    nextOrderedIDs: orderedRecords.map(\.id)
                )
                if activePhotoID != nil { activePhotoID = anchored }
                loadState = records.isEmpty ? .empty : .content
            } catch is CancellationError {
                return
            } catch {
                guard requestGeneration == generation else { return }
                let message = (error as? LocalizedError)?.errorDescription ?? error.localizedDescription
                if records.isEmpty {
                    loadState = .failed(message)
                } else {
                    loadState = .content
                    refreshError = message
                }
            }

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

    func setSort(_ sort: LibrarySort) async {
        self.sort = sort
        if sort == .added { grouping = .all }
        resetBrowsingContext()
        await rebuildPresentation()
    }
    func setGrouping(_ grouping: LibraryGrouping) async {
        self.grouping = grouping
        if grouping != .all { sort = .captured }
        resetBrowsingContext()
        await rebuildPresentation()
    }

    func beginSelection() {
        if !isSelecting { groupingBeforeSelection = grouping }
        isSelecting = true
        selectedPhotoIDs.removeAll()
    }

    func endSelection() {
        finishSelection(restoringGrouping: true)
    }

    func activate(_ id: Int) {
        if isSelecting {
            if selectedPhotoIDs.contains(id) {
                selectedPhotoIDs.remove(id)
            } else {
                selectedPhotoIDs.insert(id)
            }
        } else {
            activePhotoID = id
        }
    }

    func selectFromLongPress(_ id: Int) {
        if !isSelecting { beginSelection() }
        selectedPhotoIDs.insert(id)
    }

    func clearFilters() {
        applyFilters(LibraryFilters())
    }

    func observeVisible(firstID: Int?, distanceFromNewest: CGFloat) {
        let atNewest = distanceFromNewest <= 2
        let browsingHistory = distanceFromNewest >= 24
        if firstVisiblePhotoID != firstID { firstVisiblePhotoID = firstID }
        if isAtNewestEdge != atNewest { isAtNewestEdge = atNewest }
        if isBrowsingHistory != browsingHistory { isBrowsingHistory = browsingHistory }
    }

    private func finishSelection(restoringGrouping: Bool) {
        isSelecting = false
        selectedPhotoIDs.removeAll()
        defer { groupingBeforeSelection = nil }
        guard restoringGrouping,
              let prior = groupingBeforeSelection,
              prior != grouping else { return }
        grouping = prior
        if prior != .all { sort = .captured }
        resetBrowsingContext()
        Task { await rebuildPresentation() }
    }

    private func rebuildPresentation() async {
        presentationGeneration += 1
        let requestedGeneration = presentationGeneration
        let records = records
        let sort = sort
        let grouping = grouping
        let presentation = await Task.detached(priority: .userInitiated) {
            let signpost = SpikeSignposts.beginCapturedPresentation(
                recordCount: records.count,
                grouping: grouping,
                sort: sort
            )
            let presentation = LibraryPresentationBuilder.build(
                records: records,
                sort: sort,
                grouping: grouping
            )
            SpikeSignposts.endCapturedPresentation(
                signpost,
                recordCount: records.count,
                sectionCount: presentation.sections.count
            )
            return presentation
        }.value
        guard requestedGeneration == presentationGeneration else { return }
        orderedRecords = presentation.0
        sections = presentation.1
        presentationRevision &+= 1
    }

    private func resetBrowsingContext() {
        firstVisiblePhotoID = nil
        isAtNewestEdge = true
        isBrowsingHistory = false
        browsingResetVersion += 1
    }
}

enum LibraryPresentationBuilder {
    private struct CapturedRecord {
        let record: PhotoRecord
        let date: Date
    }

    static func build(
        records: [PhotoRecord],
        sort: LibrarySort,
        grouping: LibraryGrouping
    ) -> (ordered: [PhotoRecord], sections: [PhotoSection]) {
        if sort == .added {
            let ordered = records.sorted { $0.id < $1.id }
            return (ordered, [allSection(ordered)])
        }

        var captured: [CapturedRecord] = []
        captured.reserveCapacity(records.count)
        for record in records {
            captured.append(
                CapturedRecord(record: record, date: PhotoDateResolver.date(for: record))
            )
        }
        captured.sort { left, right in
            if left.date == right.date {
                return left.record.id < right.record.id
            }
            return left.date < right.date
        }
        var ordered: [PhotoRecord] = []
        ordered.reserveCapacity(captured.count)
        for item in captured {
            ordered.append(item.record)
        }
        guard grouping != .all else {
            return (ordered, [allSection(ordered)])
        }

        let monthSymbols = grouping == .months ? PhotoDateResolver.calendar.monthSymbols : []
        var sections: [PhotoSection] = []
        var currentID: PhotoSection.ID?
        var currentTitle = ""
        var currentPhotos: [PhotoRecord] = []

        for item in captured {
            let components = PhotoDateResolver.calendar.dateComponents(
                [.year, .month],
                from: item.date
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
                        PhotoSection(id: currentID, title: currentTitle, photos: currentPhotos)
                    )
                }
                currentID = id
                currentTitle = grouping == .years
                    ? String(year)
                    : "\(monthSymbols[max(0, min(11, month - 1))]) \(year)"
                currentPhotos = []
            }
            currentPhotos.append(item.record)
        }

        if let currentID {
            sections.append(
                PhotoSection(id: currentID, title: currentTitle, photos: currentPhotos)
            )
        }
        return (ordered, sections)
    }

    private static func allSection(_ ordered: [PhotoRecord]) -> PhotoSection {
        PhotoSection(
            id: .init(year: 0, month: 0, discriminator: "all"),
            title: "",
            photos: ordered
        )
    }
}

@MainActor
final class SearchStore: ObservableObject {
    enum State: Equatable {
        case idle
        case waiting
        case loading
        case results
        case empty
        case failed(String)
    }

    @Published var query = "" {
        didSet { schedule() }
    }
    @Published private(set) var state: State = .idle
    @Published private(set) var records: [PhotoRecord] = []
    @Published var activePhotoID: Int?

    private let api: any PhotoBrainAPI
    private var task: Task<Void, Never>?
    private var generation = 0

    init(api: any PhotoBrainAPI) {
        self.api = api
    }

    func retry() {
        schedule(immediate: true)
    }

    func clear() {
        query = ""
    }

    private func schedule(immediate: Bool = false) {
        generation += 1
        let currentGeneration = generation
        task?.cancel()
        let trimmed = query.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else {
            records = []
            state = .idle
            return
        }
        state = immediate ? .loading : .waiting
        task = Task { [api] in
            do {
                if !immediate {
                    try await Task.sleep(for: .milliseconds(350))
                }
                guard !Task.isCancelled, currentGeneration == generation else { return }
                state = .loading
                let response = try await api.search(query: trimmed, limit: 50)
                guard !Task.isCancelled, currentGeneration == generation else { return }
                records = response.photos.map { PhotoRecord(dto: $0, apiBaseURL: api.baseURL) }
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
final class SimilarPhotosStore: ObservableObject {
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
    private var task: Task<Void, Never>?
    private var generation = 0

    init(api: any PhotoBrainAPI) {
        self.api = api
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
                let response = try await api.similarPhotos(id: sourceID, limit: Self.resultLimit)
                guard !Task.isCancelled, currentGeneration == generation else { return }
                guard response.indexed else {
                    records = []
                    state = .notIndexed
                    return
                }
                records = response.photos.map { PhotoRecord(dto: $0, apiBaseURL: api.baseURL) }
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
