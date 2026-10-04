import Foundation

/// The country part of the place filter. The name is kept for chips; only `code` is sent.
struct PlaceCountryFilter: Hashable, Sendable {
    /// ISO 3166-1 alpha-2, e.g. `JP`.
    let code: String
    let name: String
}

/// The city part of the place filter. Only `id` (the GeoNames id) is sent.
struct PlaceCityFilter: Hashable, Sendable {
    let id: Int
    let name: String
    let region: String?
    let countryCode: String
}

/// User-facing rendering of places.
enum PlaceName {
    /// City, then region when present and different from the city, then country, joined by
    /// ", " (`Kyoto, Japan`; `Portland, Oregon, United States`).
    static func label(city: String, region: String?, country: String) -> String {
        var parts = [city]
        if let region, !region.isEmpty, region != city { parts.append(region) }
        parts.append(country)
        return parts.joined(separator: ", ")
    }

    static func label(_ place: PhotoPlaceDTO) -> String {
        label(city: place.city, region: place.region, country: place.country)
    }
}

/// Rows for the filter sheet's Places category, built from `FilterOptionsDTO`.
enum PlaceFilterOptions {
    struct Country: Identifiable, Equatable {
        let filter: PlaceCountryFilter
        /// Photos taken there in scope; nil for an active country the server no longer lists.
        let count: Int?
        var id: String { filter.code }
    }

    struct City: Identifiable, Equatable {
        let filter: PlaceCityFilter
        /// Photos taken there in scope; nil for an active city the server no longer lists.
        let count: Int?
        var id: Int { filter.id }
    }

    /// Server order (count desc, name asc); an active country absent from the options stays
    /// selectable at the top.
    static func countries(_ options: [CountryCountDTO], active: PlaceCountryFilter?) -> [Country] {
        let rows = options.map { Country(filter: PlaceCountryFilter(code: $0.code, name: $0.name), count: $0.count) }
        guard let active, !options.contains(where: { $0.code == active.code }) else { return rows }
        return [Country(filter: active, count: nil)] + rows
    }

    /// The cities of one country in server order; an active city of that country absent from
    /// the options stays selectable at the top.
    static func cities(_ options: [PlaceCountDTO], countryCode: String, active: PlaceCityFilter?) -> [City] {
        let rows = options.lazy.filter { $0.countryCode == countryCode }.map {
            City(
                filter: PlaceCityFilter(id: $0.id, name: $0.name, region: $0.region, countryCode: $0.countryCode),
                count: $0.count
            )
        }
        guard let active, active.countryCode == countryCode, !rows.contains(where: { $0.filter.id == active.id }) else {
            return Array(rows)
        }
        return [City(filter: active, count: nil)] + rows
    }
}

/// Backs the Place row in the loupe's info sheet for one photo. The row is hidden unless a
/// place loaded: a photo without a place and a failed request both end in `.none`.
@MainActor
final class PhotoPlaceStore: ObservableObject {
    enum State: Equatable {
        case loading
        case none
        case loaded(PhotoPlaceDTO)
    }

    let photoID: Int
    @Published private(set) var state: State = .loading
    private let api: any PhotoBrainAPI

    init(photoID: Int, api: any PhotoBrainAPI) {
        self.photoID = photoID
        self.api = api
    }

    var place: PhotoPlaceDTO? {
        guard case let .loaded(place) = state else { return nil }
        return place
    }

    func load() async {
        state = .loading
        do {
            state = try await api.photoPlace(id: photoID).place.map(State.loaded) ?? State.none
        } catch is CancellationError {
            return
        } catch {
            state = .none
        }
    }
}
