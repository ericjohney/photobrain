import XCTest
@testable import PhotoBrain

private let kyotoPlace = PhotoPlaceDTO(id: 1_857_910, city: "Kyoto", region: "Kyoto", country: "Japan", countryCode: "JP")
private let japan = PlaceCountryFilter(code: "JP", name: "Japan")
private let usa = PlaceCountryFilter(code: "US", name: "United States")
private let kyoto = PlaceCityFilter(id: 1_857_910, name: "Kyoto", region: "Kyoto", countryCode: "JP")
private let osaka = PlaceCityFilter(id: 1_853_909, name: "Osaka", region: "Osaka", countryCode: "JP")

final class PhotoPlacesAPITests: XCTestCase {
    private let decoder = APIModelCoding.decoder()

    override func tearDown() {
        StubURLProtocol.reset()
        super.tearDown()
    }

    func testFilterOptionsDecodeCountriesAndPlaces() throws {
        let json = #"{"cameras":[],"lenses":[],"isos":[],"dates":[],"tags":[],"#
            + #""countries":[{"code":"JP","name":"Japan","count":12},{"code":"US","name":"United States","count":3}],"#
            + #""places":[{"id":1857910,"name":"Kyoto","region":"Kyoto","countryCode":"JP","count":9},"#
            + #"{"id":5746545,"name":"Portland","region":null,"countryCode":"US","count":3}]}"#
        let options = try decoder.decode(FilterOptionsDTO.self, from: Data(json.utf8))

        XCTAssertEqual(options.countries, [
            CountryCountDTO(code: "JP", name: "Japan", count: 12),
            CountryCountDTO(code: "US", name: "United States", count: 3),
        ])
        XCTAssertEqual(options.places, [
            PlaceCountDTO(id: 1_857_910, name: "Kyoto", region: "Kyoto", countryCode: "JP", count: 9),
            PlaceCountDTO(id: 5_746_545, name: "Portland", region: nil, countryCode: "US", count: 3),
        ])
    }

    func testFilterOptionsWithoutPlaceKeysDecodeAsEmpty() throws {
        let json = #"{"cameras":["X100V"],"lenses":[],"isos":[],"dates":[],"tags":[{"tag":"dog","count":1}]}"#
        let options = try decoder.decode(FilterOptionsDTO.self, from: Data(json.utf8))
        XCTAssertEqual(options.cameras, ["X100V"])
        XCTAssertEqual(options.tags.map(\.tag), ["dog"])
        XCTAssertEqual(options.countries, [])
        XCTAssertEqual(options.places, [])
    }

    func testFilterOptionsWithNullPlaceKeysDecodeAsEmpty() throws {
        let json = #"{"cameras":[],"lenses":[],"isos":[],"dates":[],"countries":null,"places":null}"#
        let options = try decoder.decode(FilterOptionsDTO.self, from: Data(json.utf8))
        XCTAssertEqual(options.countries, [])
        XCTAssertEqual(options.places, [])
    }

    func testPhotoPlaceResponseDecodesPlaceAndNull() throws {
        let present = #"{"place":{"id":1857910,"city":"Kyoto","region":"Kyoto","country":"Japan","countryCode":"JP"}}"#
        XCTAssertEqual(try decoder.decode(PhotoPlaceResponseDTO.self, from: Data(present.utf8)).place, kyotoPlace)

        let noRegion = #"{"place":{"id":2,"city":"Monaco","region":null,"country":"Monaco","countryCode":"MC"}}"#
        XCTAssertNil(try decoder.decode(PhotoPlaceResponseDTO.self, from: Data(noRegion.utf8)).place?.region)

        XCTAssertNil(try decoder.decode(PhotoPlaceResponseDTO.self, from: Data(#"{"place":null}"#.utf8)).place)
    }

    func testPhotoPlaceRequestsPlacePath() async throws {
        StubURLProtocol.respond(
            status: 200,
            body: #"{"place":{"id":1857910,"city":"Kyoto","region":"Kyoto","country":"Japan","countryCode":"JP"}}"#
        )
        let response = try await StubURLProtocol.makeClient().photoPlace(id: 42)

        let request = try XCTUnwrap(StubURLProtocol.requests.first)
        XCTAssertEqual(StubURLProtocol.requests.count, 1)
        XCTAssertEqual(request.httpMethod, "GET")
        XCTAssertEqual(request.url?.path, "/api/v1/photos/42/place")
        XCTAssertNil(request.url?.query)
        XCTAssertEqual(response.place, kyotoPlace)
    }

    func testPhotoPlaceMissingPhotoMapsServerEnvelope() async {
        StubURLProtocol.respond(
            status: 404,
            body: #"{"error":{"code":"PHOTO_NOT_FOUND","message":"Photo not found"}}"#
        )
        do {
            _ = try await StubURLProtocol.makeClient().photoPlace(id: 999)
            XCTFail("Expected a server error")
        } catch {
            XCTAssertEqual(
                error as? PhotoBrainAPIError,
                .server(status: 404, code: "PHOTO_NOT_FOUND", message: "Photo not found")
            )
        }
    }

    func testPhotoPlaceRejectsNonPositiveIDWithoutNetwork() async {
        for id in [0, -1] {
            do {
                _ = try await StubURLProtocol.makeClient().photoPlace(id: id)
                XCTFail("Expected invalid request for id \(id)")
            } catch {
                XCTAssertEqual(error as? PhotoBrainAPIError, .invalidRequest)
            }
        }
        XCTAssertTrue(StubURLProtocol.requests.isEmpty)
    }

    func testCountryAndPlaceAreEncodedIntoPhotosQuery() async throws {
        StubURLProtocol.respond(status: 200, body: #"{"photos":[],"total":0,"rawCount":0}"#)
        _ = try await StubURLProtocol.makeClient().photos(query: PhotoQuery(tag: "dog", country: "JP", place: 1_857_910))

        let items = try queryItems(of: XCTUnwrap(StubURLProtocol.requests.first))
        XCTAssertEqual(items.map(\.name), ["filterRaw", "tag", "country", "place"])
        XCTAssertEqual(items.first { $0.name == "country" }?.value, "JP")
        XCTAssertEqual(items.first { $0.name == "place" }?.value, "1857910")
    }

    func testCountryAndPlaceAreEncodedIntoLocationsQuery() async throws {
        StubURLProtocol.respond(status: 200, body: #"{"points":[],"total":0}"#)
        _ = try await StubURLProtocol.makeClient().locations(query: PhotoQuery(country: "US"))

        let request = try XCTUnwrap(StubURLProtocol.requests.first)
        XCTAssertEqual(request.url?.path, "/api/v1/locations")
        XCTAssertEqual(try queryItems(of: request).map(\.name), ["filterRaw", "country"])
    }

    func testUnsetCountryAndPlaceAreOmittedFromQuery() {
        XCTAssertEqual(PhotoQuery(flag: .pick).queryItems.map(\.name), ["filterRaw", "flag"])
    }

    func testCountryAndPlaceAreSentInSearchBody() async throws {
        let body = try await sentSearchBody(filters: PhotoQuery(country: "JP", place: 1_857_910))
        XCTAssertEqual(body["country"] as? String, "JP")
        XCTAssertEqual(body["place"] as? Int, 1_857_910)
    }

    func testUnsetCountryAndPlaceAreOmittedFromSearchBody() async throws {
        let body = try await sentSearchBody(filters: PhotoQuery(tag: "beach"))
        XCTAssertEqual(Set(body.keys), ["query", "limit", "filterRaw", "tag"])
    }

    private func sentSearchBody(filters: PhotoQuery) async throws -> [String: Any] {
        StubURLProtocol.respond(status: 200, body: #"{"photos":[],"total":0,"query":"temple"}"#)
        _ = try await StubURLProtocol.makeClient().search(query: "temple", limit: 10, filters: filters)
        let request = try XCTUnwrap(StubURLProtocol.requests.first)
        let data = try XCTUnwrap(request.httpBody)
        return try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
    }

    private func queryItems(of request: URLRequest) throws -> [URLQueryItem] {
        URLComponents(url: try XCTUnwrap(request.url), resolvingAgainstBaseURL: false)?.queryItems ?? []
    }
}

final class PlaceNameTests: XCTestCase {
    func testRegionEqualToCityIsOmitted() {
        XCTAssertEqual(PlaceName.label(city: "Kyoto", region: "Kyoto", country: "Japan"), "Kyoto, Japan")
        XCTAssertEqual(PlaceName.label(kyotoPlace), "Kyoto, Japan")
    }

    func testDistinctRegionIsIncluded() {
        XCTAssertEqual(
            PlaceName.label(city: "Portland", region: "Oregon", country: "United States"),
            "Portland, Oregon, United States"
        )
    }

    func testMissingRegionIsOmitted() {
        XCTAssertEqual(PlaceName.label(city: "Monaco", region: nil, country: "Monaco"), "Monaco, Monaco")
        XCTAssertEqual(PlaceName.label(city: "Reykjavik", region: "", country: "Iceland"), "Reykjavik, Iceland")
    }
}

final class PlaceFilterTests: XCTestCase {
    func testSelectingCountryIsActiveChippedAndQueried() {
        let filters = LibraryFilters().selectingCountry(japan)
        XCTAssertTrue(filters.isActive)
        XCTAssertEqual(filters.activeFields, [LibraryFilters.ActiveFilter(field: .country, title: "Japan")])
        XCTAssertEqual(filters.summary, "Japan")
        XCTAssertEqual(filters.photoQuery, PhotoQuery(country: "JP"))
    }

    func testSelectingCityAddsCityChipAfterCountry() {
        let filters = LibraryFilters(minRating: 2).selectingCity(kyoto, in: japan)
        XCTAssertEqual(filters.activeFields.map(\.field), [.minRating, .country, .place])
        XCTAssertEqual(filters.summary, "★★+, Japan, Kyoto")
        XCTAssertEqual(filters.photoQuery, PhotoQuery(minRating: 2, country: "JP", place: 1_857_910))
    }

    func testClearingCountryClearsCity() {
        let filters = LibraryFilters(tag: "temple").selectingCity(kyoto, in: japan)
        let removed = filters.removing(.country)
        XCTAssertNil(removed.country)
        XCTAssertNil(removed.place)
        XCTAssertEqual(removed.tag, "temple")
        XCTAssertEqual(removed.photoQuery, PhotoQuery(tag: "temple"))

        let anywhere = filters.selectingCountry(nil)
        XCTAssertNil(anywhere.country)
        XCTAssertNil(anywhere.place)
    }

    func testClearingCityKeepsCountry() {
        let removed = LibraryFilters().selectingCity(kyoto, in: japan).removing(.place)
        XCTAssertEqual(removed.country, japan)
        XCTAssertNil(removed.place)
        XCTAssertEqual(removed.photoQuery, PhotoQuery(country: "JP"))
    }

    func testChangingCountryDropsCityOutsideItButKeepsCityInside() {
        let inJapan = LibraryFilters().selectingCity(kyoto, in: japan)
        XCTAssertEqual(inJapan.selectingCountry(japan).place, kyoto)
        let moved = inJapan.selectingCountry(usa)
        XCTAssertEqual(moved.country, usa)
        XCTAssertNil(moved.place)
    }

    func testSelectingPhotoPlaceSetsCityAndCountry() {
        let filters = LibraryFilters().selectingPlace(kyotoPlace)
        XCTAssertEqual(filters.country, japan)
        XCTAssertEqual(filters.place, kyoto)
    }

    func testClearRemovesPlaceFilters() {
        var filters = LibraryFilters().selectingCity(kyoto, in: japan)
        filters.clear()
        XCTAssertFalse(filters.isActive)
        XCTAssertEqual(filters.summary, "All Items")
    }

    func testCountryOptionsKeepServerOrderAndActiveUnlistedCountry() {
        let options = [CountryCountDTO(code: "US", name: "United States", count: 4)]
        XCTAssertEqual(PlaceFilterOptions.countries(options, active: nil).map(\.id), ["US"])
        let rows = PlaceFilterOptions.countries(options, active: japan)
        XCTAssertEqual(rows.map(\.id), ["JP", "US"])
        XCTAssertNil(rows.first?.count)
        XCTAssertEqual(PlaceFilterOptions.countries(options, active: usa).map(\.count), [4])
    }

    func testCityOptionsAreScopedToCountry() {
        let places = [
            PlaceCountDTO(id: 5_746_545, name: "Portland", region: "Oregon", countryCode: "US", count: 8),
            PlaceCountDTO(id: osaka.id, name: "Osaka", region: "Osaka", countryCode: "JP", count: 5),
            PlaceCountDTO(id: kyoto.id, name: "Kyoto", region: "Kyoto", countryCode: "JP", count: 2),
        ]
        let rows = PlaceFilterOptions.cities(places, countryCode: "JP", active: nil)
        XCTAssertEqual(rows.map(\.filter), [osaka, kyoto])
        XCTAssertEqual(rows.map(\.count), [5, 2])

        let unlisted = PlaceCityFilter(id: 99, name: "Nara", region: "Nara", countryCode: "JP")
        XCTAssertEqual(PlaceFilterOptions.cities(places, countryCode: "JP", active: unlisted).map(\.id), [99, osaka.id, kyoto.id])
        XCTAssertEqual(PlaceFilterOptions.cities(places, countryCode: "US", active: unlisted).map(\.id), [5_746_545])
    }
}

final class PlaceSmartAlbumTests: XCTestCase {
    func testLibraryPlaceFiltersBecomeSavedCriteria() {
        let filters = LibraryFilters(mediaKind: .raw).selectingCity(kyoto, in: japan)
        let criteria = SmartAlbumFilters(filters)
        XCTAssertEqual(criteria, SmartAlbumFilters(filterRaw: .raw, country: "JP", place: 1_857_910))
        XCTAssertFalse(criteria.isEmpty)
        XCTAssertEqual(criteria.photoQuery, PhotoQuery(filterRaw: .raw, country: "JP", place: 1_857_910))
        XCTAssertFalse(SmartAlbumFilters(country: "JP").isEmpty)
        XCTAssertFalse(SmartAlbumFilters(place: 1).isEmpty)
    }

    func testCriteriaRoundTripCountryAndPlace() throws {
        let criteria = SmartAlbumFilters(tag: "temple", country: "JP", place: 1_857_910)
        let data = try APIModelCoding.encoder().encode(criteria)
        let object = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
        XCTAssertEqual(Set(object.keys), ["tag", "country", "place"])
        XCTAssertEqual(object["country"] as? String, "JP")
        XCTAssertEqual(object["place"] as? Int, 1_857_910)
        XCTAssertEqual(try APIModelCoding.decoder().decode(SmartAlbumFilters.self, from: data), criteria)
    }

    func testCriteriaOmitUnsetPlaceKeys() throws {
        let data = try APIModelCoding.encoder().encode(SmartAlbumFilters(flag: .pick))
        let object = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
        XCTAssertEqual(Set(object.keys), ["flag"])
    }

    func testCountryOnlyAlbumIsSavable() throws {
        let draft = try SmartAlbumDraft.validated(name: "Japan", filters: SmartAlbumFilters(country: "JP"), query: nil)
        XCTAssertEqual(draft.filters.country, "JP")
    }

    func testDecodedAlbumCriteriaCarryPlace() throws {
        let json = #"{"id":2,"name":"Kyoto","filters":{"country":"JP","place":1857910},"query":"temple","#
            + #""photoCount":null,"cover":null,"createdAt":"2024-01-02T03:04:05Z","updatedAt":"2024-01-02T03:04:05Z"}"#
        let album = try APIModelCoding.decoder().decode(SmartAlbumDTO.self, from: Data(json.utf8))
        XCTAssertEqual(album.filters, SmartAlbumFilters(country: "JP", place: 1_857_910))
        XCTAssertEqual(
            PhotoListingSource(scope: .smartAlbum(filters: album.filters, query: album.query), filters: LibraryFilters()),
            .search(
                query: "temple",
                limit: PhotoListingSource.smartAlbumSearchLimit,
                filters: PhotoQuery(country: "JP", place: 1_857_910)
            )
        )
    }
}

@MainActor
final class PlaceSelectionStoreTests: XCTestCase {
    private func loadedLibrary(api: TestAPI) async -> LibraryStore {
        let photos = [TestModels.photo(id: 1), TestModels.photo(id: 2)]
        await api.setPhotos(PhotosResponseDTO(photos: photos, total: photos.count, rawCount: 0))
        let store = LibraryStore(api: api)
        await store.load()
        return store
    }

    private func waitForLastQuery(_ expected: PhotoQuery, api: TestAPI) async throws {
        let deadline = ContinuousClock.now + .seconds(3)
        while await api.recordedPhotoQueries().last != expected {
            guard ContinuousClock.now < deadline else {
                XCTFail("Timed out waiting for query \(expected)")
                return
            }
            try await Task.sleep(for: .milliseconds(10))
        }
    }

    func testLibraryLoadsPlaceOptions() async {
        let api = TestAPI()
        await api.setFilterOptions(FilterOptionsDTO(
            cameras: [],
            lenses: [],
            isos: [],
            dates: [],
            countries: [CountryCountDTO(code: "JP", name: "Japan", count: 4)],
            places: [PlaceCountDTO(id: kyoto.id, name: "Kyoto", region: "Kyoto", countryCode: "JP", count: 4)]
        ))
        let store = await loadedLibrary(api: api)
        XCTAssertEqual(store.filterOptions?.countries.map(\.code), ["JP"])
        XCTAssertEqual(store.filterOptions?.places.map(\.id), [kyoto.id])
    }

    func testSelectCountryThenCityThenClearCountry() async throws {
        let api = TestAPI()
        let store = await loadedLibrary(api: api)

        store.applyFilters(store.filters.selectingCountry(japan))
        try await waitForLastQuery(PhotoQuery(country: "JP"), api: api)

        store.applyFilters(store.filters.selectingCity(kyoto, in: japan))
        try await waitForLastQuery(PhotoQuery(country: "JP", place: kyoto.id), api: api)
        XCTAssertEqual(store.filters.activeFields.map(\.title), ["Japan", "Kyoto"])

        store.applyFilters(store.filters.removing(.country))
        XCTAssertNil(store.filters.place)
        try await waitForLastQuery(PhotoQuery(), api: api)
    }

    func testLoupePlaceRowClosesLoupeAndAppliesPlace() async throws {
        let api = TestAPI()
        let store = await loadedLibrary(api: api)
        store.applyFilters(LibraryFilters(tag: "temple"))
        try await waitForLastQuery(PhotoQuery(tag: "temple"), api: api)
        store.activePhotoID = 2

        store.show(.place(kyotoPlace))

        XCTAssertNil(store.activePhotoID)
        XCTAssertEqual(store.filters.summary, "#temple, Japan, Kyoto")
        try await waitForLastQuery(PhotoQuery(tag: "temple", country: "JP", place: kyoto.id), api: api)

        store.show(.tag("shrine"))
        try await waitForLastQuery(PhotoQuery(tag: "shrine", country: "JP", place: kyoto.id), api: api)
    }

    func testSearchSendsPlaceFilters() async throws {
        let api = TestAPI()
        let search = SearchStore(api: api)
        search.query = "temple"
        search.applyFilters(LibraryFilters().selectingCity(kyoto, in: japan))
        let expected = PhotoQuery(country: "JP", place: kyoto.id)
        let deadline = ContinuousClock.now + .seconds(3)
        while await api.recordedSearchRequests().last?.filters != expected, ContinuousClock.now < deadline {
            try await Task.sleep(for: .milliseconds(10))
        }
        let last = await api.recordedSearchRequests().last
        XCTAssertEqual(last?.query, "temple")
        XCTAssertEqual(last?.filters, expected)
    }

    func testMapScopeKeepsPlaceFilters() async {
        let api = TestAPI()
        let filters = LibraryFilters().selectingCity(kyoto, in: japan)
        let map = MapStore(filters: filters, api: api)
        await map.load()
        let queries = await api.recordedLocationQueries()
        XCTAssertEqual(queries, [PhotoQuery(country: "JP", place: kyoto.id)])
    }

    func testLoupePlaceLoadSuccess() async {
        let api = TestAPI()
        await api.setPhotoPlace(id: 5, .success(PhotoPlaceResponseDTO(place: kyotoPlace)))
        let store = PhotoPlaceStore(photoID: 5, api: api)
        XCTAssertEqual(store.state, .loading)
        XCTAssertNil(store.place)

        await store.load()

        XCTAssertEqual(store.state, .loaded(kyotoPlace))
        XCTAssertEqual(store.place, kyotoPlace)
        let requests = await api.recordedPhotoPlaceRequests()
        XCTAssertEqual(requests, [5])
    }

    func testLoupePlaceLoadNilHidesRow() async {
        let api = TestAPI()
        await api.setPhotoPlace(id: 5, .success(PhotoPlaceResponseDTO(place: nil)))
        let store = PhotoPlaceStore(photoID: 5, api: api)
        await store.load()
        XCTAssertEqual(store.state, .none)
        XCTAssertNil(store.place)
    }

    func testLoupePlaceNotFoundAndErrorsHideRow() async {
        let api = TestAPI()
        let store = PhotoPlaceStore(photoID: 8, api: api)
        await store.load()
        XCTAssertEqual(store.state, .none, "404 PHOTO_NOT_FOUND hides the row")

        await api.setPhotoPlace(id: 8, .failure(.transport("The network connection was lost.")))
        await store.load()
        XCTAssertNil(store.place)

        await api.setPhotoPlace(id: 8, .success(PhotoPlaceResponseDTO(place: kyotoPlace)))
        await store.load()
        XCTAssertEqual(store.place, kyotoPlace)
        let requests = await api.recordedPhotoPlaceRequests()
        XCTAssertEqual(requests, [8, 8, 8])
    }
}
