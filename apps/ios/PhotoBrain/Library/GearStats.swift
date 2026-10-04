import Foundation

/// A camera or lens row tapped in Gear Stats; applied as the Library's `camera`/`lens` filter.
enum GearSelection: Hashable, Sendable {
    case camera(String)
    case lens(String)
}

/// Display rules for Gear Stats, shared with the web client: header text, top-N lists,
/// accessibility labels, and the shots-per-year breakdown.
enum GearStatsPresentation {
    /// Cameras and lenses show this many rows until "Show All".
    static let listLimit = 10
    /// Shots per year segments the most-used cameras; the rest are grouped as "Other".
    static let yearCameraLimit = 5
    static let otherLabel = "Other"
    static let emptyText = "No photos match these filters"
    static let noDatedCameraText = "No dated camera data"

    /// `1,234 photos · 1,100 with camera data`.
    static func headerText(total: Int, withExif: Int) -> String {
        "\(CountText.photos(total)) · \(withExif.formatted()) with camera data"
    }

    /// The first `listLimit` entries, or all of them when `showAll` is set.
    static func visible(_ counts: [GearCountDTO], showAll: Bool) -> ArraySlice<GearCountDTO> {
        showAll ? counts[...] : counts.prefix(listLimit)
    }

    /// Whether a list has rows beyond the first `listLimit`.
    static func hasMore(_ counts: [GearCountDTO]) -> Bool {
        counts.count > listLimit
    }

    /// `35–49 mm: 120 photos`.
    static func accessibilityLabel(_ bucket: GearBucketDTO) -> String {
        "\(bucket.label): \(CountText.photos(bucket.count))"
    }

    /// `Canon EOS R5: 12 photos`.
    static func accessibilityLabel(_ entry: GearCountDTO) -> String {
        "\(entry.label): \(CountText.photos(entry.count))"
    }

    /// Bar length for `count` relative to the largest count shown; 0 when nothing is counted.
    static func fraction(_ count: Int, of maximum: Int) -> Double {
        maximum > 0 ? Double(count) / Double(maximum) : 0
    }

    /// One year's segmented bar in Shots per year.
    struct YearShots: Identifiable, Equatable, Sendable {
        struct Segment: Equatable, Sendable {
            /// Index into the breakdown's `cameras`; `nil` for the grouped "Other" segment.
            let cameraIndex: Int?
            let label: String
            let count: Int
        }

        let year: Int
        let total: Int
        /// Top cameras in rank order, then "Other"; zero segments are omitted.
        let segments: [Segment]

        var id: Int { year }

        /// `2023: 120 photos; Canon EOS R5 80, Other 40`.
        var accessibilityLabel: String {
            let parts = segments.map { "\($0.label) \($0.count.formatted())" }.joined(separator: ", ")
            return "\(year): \(CountText.photos(total)); \(parts)"
        }
    }

    /// Shots per year: `cameras` are the `yearCameraLimit` cameras with the most dated photos
    /// (count descending, then name); `hasOther` tells whether any year has an "Other" segment.
    struct YearBreakdown: Equatable, Sendable {
        let cameras: [String]
        let years: [YearShots]
        let hasOther: Bool

        var isEmpty: Bool { years.isEmpty }
        /// Largest yearly total, the full bar length.
        var maximumTotal: Int { years.map(\.total).max() ?? 0 }
    }

    static func yearBreakdown(_ cameraYears: [GearCameraYearDTO]) -> YearBreakdown {
        var totalsByCamera: [String: Int] = [:]
        var countsByYear: [Int: [String: Int]] = [:]
        for entry in cameraYears {
            totalsByCamera[entry.camera, default: 0] += entry.count
            countsByYear[entry.year, default: [:]][entry.camera, default: 0] += entry.count
        }
        let cameras = totalsByCamera
            .sorted { $0.value != $1.value ? $0.value > $1.value : $0.key < $1.key }
            .prefix(yearCameraLimit)
            .map(\.key)
        let rank = Dictionary(uniqueKeysWithValues: cameras.enumerated().map { ($1, $0) })
        var hasOther = false
        let years = countsByYear.keys.sorted().map { year -> YearShots in
            let counts = countsByYear[year] ?? [:]
            var segments: [YearShots.Segment] = []
            for (index, camera) in cameras.enumerated() {
                if let count = counts[camera], count > 0 {
                    segments.append(YearShots.Segment(cameraIndex: index, label: camera, count: count))
                }
            }
            let other = counts.reduce(0) { sum, entry in rank[entry.key] == nil ? sum + entry.value : sum }
            if other > 0 {
                hasOther = true
                segments.append(YearShots.Segment(cameraIndex: nil, label: otherLabel, count: other))
            }
            return YearShots(year: year, total: counts.values.reduce(0, +), segments: segments)
        }
        return YearBreakdown(cameras: cameras, years: years, hasOther: hasOther)
    }
}

/// Loads Gear Stats for one Library filter set: the same query `GET /photos` lists, so its
/// counts match the grid. A failure clears the stats and offers a retry.
@MainActor
final class GearStatsStore: ObservableObject {
    enum LoadState: Equatable {
        case idle
        case loading
        case loaded
        case empty
        case failed(String)
    }

    @Published private(set) var stats: GearStatsDTO?
    @Published private(set) var state: LoadState = .idle

    let filters: LibraryFilters
    let api: any PhotoBrainAPI
    private var generation = 0

    init(filters: LibraryFilters, api: any PhotoBrainAPI) {
        self.filters = filters
        self.api = api
    }

    func load() async {
        generation += 1
        let requestGeneration = generation
        if stats == nil { state = .loading }
        do {
            let response = try await api.gearStats(query: filters.photoQuery)
            guard !Task.isCancelled, requestGeneration == generation else { return }
            stats = response
            state = response.total == 0 ? .empty : .loaded
        } catch is CancellationError {
            return
        } catch {
            guard requestGeneration == generation else { return }
            stats = nil
            state = .failed((error as? LocalizedError)?.errorDescription ?? error.localizedDescription)
        }
    }
}

extension LibraryStore {
    /// Gear Stats row action: narrows the Library to one camera or lens (replacing any previous
    /// one), keeping the other filters, then reloads.
    func showGear(_ selection: GearSelection) {
        var updated = filters
        switch selection {
        case let .camera(camera): updated.camera = camera
        case let .lens(lens): updated.lens = lens
        }
        applyFilters(updated)
    }
}
