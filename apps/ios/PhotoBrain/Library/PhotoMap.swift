import Foundation

/// A photo's location in decimal degrees, valid by the server's rule: finite, latitude in
/// [-90, 90], longitude in [-180, 180], and not both exactly 0 (the common bogus default).
struct PhotoCoordinate: Hashable, Sendable {
    let latitude: Double
    let longitude: Double

    init?(latitude: Double, longitude: Double) {
        guard latitude.isFinite, longitude.isFinite,
              (-90...90).contains(latitude),
              (-180...180).contains(longitude),
              !(latitude == 0 && longitude == 0) else { return nil }
        self.latitude = latitude
        self.longitude = longitude
    }

    /// Parses the stored EXIF text. Only plain decimal text counts (like the server's numeric
    /// round-trip check), so `nan`, `inf`, hex floats, and blank or partial numbers are rejected.
    init?(latitude: String?, longitude: String?) {
        guard let latitude = latitude.flatMap(Self.decimal),
              let longitude = longitude.flatMap(Self.decimal) else { return nil }
        self.init(latitude: latitude, longitude: longitude)
    }

    init?(exif: PhotoEXIFDTO?) {
        self.init(latitude: exif?.gpsLatitude, longitude: exif?.gpsLongitude)
    }

    /// e.g. `37.77493, -122.41942`.
    var formatted: String {
        let style = FloatingPointFormatStyle<Double>.number.precision(.fractionLength(5)).grouping(.never)
        return "\(latitude.formatted(style)), \(longitude.formatted(style))"
    }

    private static let decimalCharacters = Set("0123456789+-.eE")

    private static func decimal(_ text: String) -> Double? {
        guard !text.isEmpty, text.allSatisfy(decimalCharacters.contains) else { return nil }
        return Double(text)
    }
}

/// Converts a visible map region into the `bounds` filter.
enum MapRegionBounds {
    /// Latitudes clamp to the poles. Longitudes normalize into [-180, 180]; a region crossing
    /// the antimeridian yields `west > east` (the contract's wrap), and a region at least 360°
    /// wide covers every longitude.
    static func bounds(
        centerLatitude: Double,
        centerLongitude: Double,
        latitudeDelta: Double,
        longitudeDelta: Double
    ) -> PhotoBounds {
        let north = min(90, centerLatitude + latitudeDelta / 2)
        let south = max(-90, centerLatitude - latitudeDelta / 2)
        guard longitudeDelta < 360 else {
            return PhotoBounds(north: north, south: south, east: 180, west: -180)
        }
        let west = normalizedLongitude(centerLongitude - longitudeDelta / 2)
        var east = normalizedLongitude(centerLongitude + longitudeDelta / 2)
        // -180 and 180 are the same meridian; as an eastern edge it closes the range at 180.
        if east == -180 { east = 180 }
        return PhotoBounds(north: north, south: south, east: east, west: west)
    }

    /// Wraps any longitude into [-180, 180).
    static func normalizedLongitude(_ longitude: Double) -> Double {
        let wrapped = (longitude + 180).truncatingRemainder(dividingBy: 360)
        return (wrapped < 0 ? wrapped + 360 : wrapped) - 180
    }
}

/// Backs the Map screen: every geotagged photo matching the Library's filters, the visible
/// region (for "Show N Photos"), and the photo opened from a marker.
@MainActor
final class MapStore: ObservableObject, CurationApplying {
    enum LoadState: Equatable {
        case idle
        case loading
        case loaded
        case empty
        case failed(String)
    }

    @Published private(set) var state: LoadState = .idle
    @Published private(set) var points: [PhotoLocationPointDTO] = []
    /// Bumped on each successful load so the map refits its region to the new points.
    @Published private(set) var pointsVersion = 0
    @Published private(set) var visibleBounds: PhotoBounds?
    /// Photo opened from a single marker, shown in the loupe.
    @Published var openRecord: PhotoRecord?
    @Published private(set) var isOpeningPhoto = false
    @Published private(set) var openError: String?

    /// The Library's filters without any region; the map always covers the whole world.
    let filters: LibraryFilters
    let api: any PhotoBrainAPI
    let curation: PhotoCurationCenter
    private var generation = 0
    private var openGeneration = 0

    init(filters: LibraryFilters, api: any PhotoBrainAPI, curation: PhotoCurationCenter? = nil) {
        var filters = filters
        filters.bounds = nil
        self.filters = filters
        self.api = api
        self.curation = curation ?? PhotoCurationCenter(api: api)
        self.curation.register(self)
    }

    /// Points inside the visible region; all points until the map reports one.
    var visibleCount: Int {
        guard let visibleBounds else { return points.count }
        return points.reduce(0) { count, point in
            visibleBounds.contains(latitude: point.latitude, longitude: point.longitude) ? count + 1 : count
        }
    }

    /// The Library's filters narrowed to the visible region, for the "Show N Photos" grid.
    var visibleAreaFilters: LibraryFilters? {
        guard let visibleBounds else { return nil }
        var area = filters
        area.bounds = visibleBounds
        return area
    }

    /// Replaces the points; a reload keeps the current points visible until it settles.
    func load() async {
        generation += 1
        let requestGeneration = generation
        if points.isEmpty { state = .loading }
        do {
            let response = try await api.locations(query: filters.photoQuery)
            guard !Task.isCancelled, requestGeneration == generation else { return }
            points = response.points
            pointsVersion += 1
            state = points.isEmpty ? .empty : .loaded
        } catch is CancellationError {
            return
        } catch {
            guard requestGeneration == generation else { return }
            points = []
            state = .failed(Self.message(for: error))
        }
    }

    func setVisibleBounds(_ bounds: PhotoBounds) {
        if visibleBounds != bounds { visibleBounds = bounds }
    }

    /// Loads one photo's record for the loupe. A newer tap supersedes an older one.
    func openPhoto(id: Int) async {
        openGeneration += 1
        let requestGeneration = openGeneration
        isOpeningPhoto = true
        openError = nil
        defer { if requestGeneration == openGeneration { isOpeningPhoto = false } }
        do {
            let dto = try await api.photo(id: id)
            guard !Task.isCancelled, requestGeneration == openGeneration else { return }
            openRecord = curation.overlay([PhotoRecord(dto: dto, apiBaseURL: api.baseURL)]).first
        } catch is CancellationError {
            return
        } catch {
            guard requestGeneration == openGeneration else { return }
            openError = Self.message(for: error)
        }
    }

    func dismissOpenError() {
        openError = nil
    }

    func applyCuration(id: Int, curation: PhotoCuration) {
        guard var record = openRecord, record.id == id,
              record.rating != curation.rating || record.flag != curation.flag else { return }
        record.rating = curation.rating
        record.flag = curation.flag
        openRecord = record
    }

    func applyFlag(id: Int, flag: PhotoFlag?) {
        guard let record = openRecord, record.id == id else { return }
        applyCuration(id: id, curation: PhotoCuration(rating: record.rating, flag: flag))
    }

    private static func message(for error: Error) -> String {
        (error as? LocalizedError)?.errorDescription ?? error.localizedDescription
    }
}
