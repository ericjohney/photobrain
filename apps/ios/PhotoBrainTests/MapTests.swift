import XCTest
@testable import PhotoBrain

final class MapAPITests: XCTestCase {
    override func tearDown() {
        StubURLProtocol.reset()
        super.tearDown()
    }

    func testLocationsResponseDecodesNumericPoints() throws {
        let json = #"{"points":[{"id":3,"latitude":37.7749,"longitude":-122.4194},{"id":9,"latitude":-33.8688,"longitude":151.2093}],"total":2}"#
        let response = try APIModelCoding.decoder().decode(LocationsResponseDTO.self, from: Data(json.utf8))
        XCTAssertEqual(response.total, 2)
        XCTAssertEqual(response.points, [
            PhotoLocationPointDTO(id: 3, latitude: 37.7749, longitude: -122.4194),
            PhotoLocationPointDTO(id: 9, latitude: -33.8688, longitude: 151.2093),
        ])
    }

    func testLocationsSendsFiltersAndAllFourBounds() async throws {
        StubURLProtocol.respond(status: 200, body: #"{"points":[],"total":0}"#)
        let query = PhotoQuery(
            filterRaw: .raw,
            minRating: 3,
            tag: "beach",
            bounds: PhotoBounds(north: 10.5, south: -5, east: -170, west: 170)
        )
        _ = try await StubURLProtocol.makeClient().locations(query: query)

        let request = try onlyRequest()
        XCTAssertEqual(request.httpMethod, "GET")
        XCTAssertEqual(request.url?.path, "/api/v1/locations")
        let items = try queryDictionary(of: request)
        XCTAssertEqual(items, [
            "filterRaw": "raw",
            "minRating": "3",
            "tag": "beach",
            "north": "10.5",
            "south": "-5.0",
            "east": "-170.0",
            "west": "170.0",
        ])
    }

    func testPhotosSendsNoBoundsItemsWhenUnset() async throws {
        StubURLProtocol.respond(status: 200, body: #"{"photos":[],"total":0,"rawCount":0}"#)
        _ = try await StubURLProtocol.makeClient().photos(query: PhotoQuery(camera: "X100V"))

        let request = try onlyRequest()
        XCTAssertEqual(request.url?.path, "/api/v1/photos")
        XCTAssertEqual(try queryDictionary(of: request), ["filterRaw": "all", "camera": "X100V"])
    }

    func testPhotosSendsAllFourBoundsWhenSet() async throws {
        StubURLProtocol.respond(status: 200, body: #"{"photos":[],"total":0,"rawCount":0}"#)
        let bounds = PhotoBounds(north: 1, south: 0.25, east: 3, west: 2)
        _ = try await StubURLProtocol.makeClient().photos(query: PhotoQuery(bounds: bounds))

        let items = try queryDictionary(of: onlyRequest())
        XCTAssertEqual(items["north"], "1.0")
        XCTAssertEqual(items["south"], "0.25")
        XCTAssertEqual(items["east"], "3.0")
        XCTAssertEqual(items["west"], "2.0")
    }

    func testSearchBodyCarriesBoundsObjectOnlyWhenSet() async throws {
        let empty = #"{"photos":[],"total":0,"query":"dog"}"#
        StubURLProtocol.respond(status: 200, body: empty)
        let bounds = PhotoBounds(north: 45, south: 40, east: -70, west: -75)
        _ = try await StubURLProtocol.makeClient().search(query: "dog", limit: 10, filters: PhotoQuery(bounds: bounds))
        let body = try jsonBody(onlyRequest())
        let sent = try XCTUnwrap(body["bounds"] as? [String: Double])
        XCTAssertEqual(sent, ["north": 45, "south": 40, "east": -70, "west": -75])

        StubURLProtocol.reset()
        StubURLProtocol.respond(status: 200, body: empty)
        _ = try await StubURLProtocol.makeClient().search(query: "dog", limit: 10, filters: PhotoQuery())
        XCTAssertNil(try jsonBody(onlyRequest())["bounds"])
    }

    private func onlyRequest() throws -> URLRequest {
        XCTAssertEqual(StubURLProtocol.requests.count, 1)
        return try XCTUnwrap(StubURLProtocol.requests.first)
    }

    private func queryDictionary(of request: URLRequest) throws -> [String: String] {
        let items = URLComponents(url: try XCTUnwrap(request.url), resolvingAgainstBaseURL: false)?.queryItems ?? []
        return Dictionary(uniqueKeysWithValues: items.map { ($0.name, $0.value ?? "") })
    }

    private func jsonBody(_ request: URLRequest) throws -> [String: Any] {
        let data = try XCTUnwrap(request.httpBody)
        return try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
    }
}

final class MapGeometryTests: XCTestCase {
    func testRegionWithinOneHemisphereKeepsWestBelowEast() {
        let bounds = MapRegionBounds.bounds(centerLatitude: 37, centerLongitude: -122, latitudeDelta: 2, longitudeDelta: 4)
        XCTAssertEqual(bounds, PhotoBounds(north: 38, south: 36, east: -120, west: -124))
    }

    func testRegionCrossingAntimeridianWrapsWithWestAboveEast() {
        let bounds = MapRegionBounds.bounds(centerLatitude: -17, centerLongitude: 178, latitudeDelta: 4, longitudeDelta: 10)
        XCTAssertEqual(bounds, PhotoBounds(north: -15, south: -19, east: -177, west: 173))
        XCTAssertTrue(bounds.contains(latitude: -17, longitude: 179.5))
        XCTAssertTrue(bounds.contains(latitude: -17, longitude: -179.5))
        XCTAssertFalse(bounds.contains(latitude: -17, longitude: 0))
    }

    func testRegionCenteredPastAntimeridianNormalizesLongitudes() {
        let bounds = MapRegionBounds.bounds(centerLatitude: 0, centerLongitude: 185, latitudeDelta: 2, longitudeDelta: 2)
        XCTAssertEqual(bounds.west, -176, accuracy: 1e-9)
        XCTAssertEqual(bounds.east, -174, accuracy: 1e-9)
    }

    func testEastEdgeOnAntimeridianClosesAt180() {
        let bounds = MapRegionBounds.bounds(centerLatitude: 0, centerLongitude: 170, latitudeDelta: 2, longitudeDelta: 20)
        XCTAssertEqual(bounds.west, 160)
        XCTAssertEqual(bounds.east, 180)
    }

    func testWholeWorldRegionClampsLatitudeAndCoversAllLongitudes() {
        let bounds = MapRegionBounds.bounds(centerLatitude: 10, centerLongitude: 40, latitudeDelta: 200, longitudeDelta: 360)
        XCTAssertEqual(bounds, PhotoBounds(north: 90, south: -90, east: 180, west: -180))
    }

    func testBoundsEdgesAreInclusive() {
        let bounds = PhotoBounds(north: 10, south: 0, east: 20, west: 10)
        XCTAssertTrue(bounds.contains(latitude: 10, longitude: 20))
        XCTAssertTrue(bounds.contains(latitude: 0, longitude: 10))
        XCTAssertFalse(bounds.contains(latitude: 10.0001, longitude: 15))
        XCTAssertFalse(bounds.contains(latitude: 5, longitude: 9.9999))
    }

    func testGPSValidityBoundaries() {
        XCTAssertNotNil(PhotoCoordinate(latitude: 90, longitude: 180))
        XCTAssertNotNil(PhotoCoordinate(latitude: -90, longitude: -180))
        XCTAssertNotNil(PhotoCoordinate(latitude: 0, longitude: 0.0001))
        XCTAssertNotNil(PhotoCoordinate(latitude: 0.0001, longitude: 0))
        XCTAssertNil(PhotoCoordinate(latitude: 0, longitude: 0))
        XCTAssertNil(PhotoCoordinate(latitude: 90.0001, longitude: 0))
        XCTAssertNil(PhotoCoordinate(latitude: -90.0001, longitude: 0))
        XCTAssertNil(PhotoCoordinate(latitude: 10, longitude: 180.0001))
        XCTAssertNil(PhotoCoordinate(latitude: 10, longitude: -180.0001))
        XCTAssertNil(PhotoCoordinate(latitude: .nan, longitude: 10))
        XCTAssertNil(PhotoCoordinate(latitude: 10, longitude: .infinity))
    }

    func testGPSValidityParsesOnlyDecimalText() {
        XCTAssertEqual(
            PhotoCoordinate(latitude: "37.7749", longitude: "-122.4194"),
            PhotoCoordinate(latitude: 37.7749, longitude: -122.4194)
        )
        XCTAssertNotNil(PhotoCoordinate(latitude: "1e1", longitude: "5"))
        XCTAssertNil(PhotoCoordinate(latitude: "0", longitude: "0.0"))
        XCTAssertNil(PhotoCoordinate(latitude: nil, longitude: "5"))
        XCTAssertNil(PhotoCoordinate(latitude: "", longitude: "5"))
        XCTAssertNil(PhotoCoordinate(latitude: "abc", longitude: "5"))
        XCTAssertNil(PhotoCoordinate(latitude: "12abc", longitude: "5"))
        XCTAssertNil(PhotoCoordinate(latitude: " 12", longitude: "5"))
        XCTAssertNil(PhotoCoordinate(latitude: "Infinity", longitude: "5"))
        XCTAssertNil(PhotoCoordinate(latitude: "nan", longitude: "5"))
        XCTAssertNil(PhotoCoordinate(latitude: "1e999", longitude: "5"))
        XCTAssertNil(PhotoCoordinate(latitude: "91", longitude: "5"))
    }

    func testFormattedCoordinates() {
        XCTAssertEqual(PhotoCoordinate(latitude: 37.774929, longitude: -122.419416)?.formatted, "37.77493, -122.41942")
    }
}

final class MapFilterTests: XCTestCase {
    func testBoundsFlowIntoPhotoQueryAndActiveFilters() {
        let bounds = PhotoBounds(north: 1, south: 0, east: 1, west: 0)
        let filters = LibraryFilters(minRating: 2, bounds: bounds)
        XCTAssertTrue(filters.isActive)
        XCTAssertEqual(filters.photoQuery.bounds, bounds)
        XCTAssertEqual(filters.activeFields.map(\.field), [.minRating, .bounds])
        XCTAssertNil(filters.removing(.bounds).bounds)
        XCTAssertTrue(LibraryFilters(bounds: bounds).isActive)
    }

    func testMapAreaScopeListsFiltersWithBounds() {
        let bounds = PhotoBounds(north: 1, south: 0, east: 1, west: 0)
        let filters = LibraryFilters(mediaKind: .raw, bounds: bounds)
        XCTAssertEqual(PhotoListingSource(scope: .mapArea, filters: filters), .photos(filters.photoQuery))
    }

    func testSmartAlbumCriteriaExcludeBounds() throws {
        let filters = LibraryFilters(mediaKind: .raw, tag: "dog", bounds: PhotoBounds(north: 1, south: 0, east: 1, west: 0))
        let criteria = SmartAlbumFilters(filters)
        XCTAssertEqual(criteria, SmartAlbumFilters(filterRaw: .raw, tag: "dog"))
        XCTAssertNil(criteria.photoQuery.bounds)

        let encoded = try JSONSerialization.jsonObject(with: APIModelCoding.encoder().encode(criteria)) as? [String: Any]
        XCTAssertEqual(Set(try XCTUnwrap(encoded).keys), ["filterRaw", "tag"])
    }

    func testBoundsOnlyFiltersAreNotSavableCriteria() {
        let criteria = SmartAlbumFilters(LibraryFilters(bounds: PhotoBounds(north: 1, south: 0, east: 1, west: 0)))
        XCTAssertTrue(criteria.isEmpty)
        XCTAssertThrowsError(try SmartAlbumDraft.validated(name: "Here", filters: criteria, query: nil)) { error in
            XCTAssertEqual(error as? SmartAlbumValidationError, .noCriteria)
        }
    }
}

@MainActor
final class MapStoreTests: XCTestCase {
    private let points = [
        PhotoLocationPointDTO(id: 1, latitude: 37.77, longitude: -122.42),
        PhotoLocationPointDTO(id: 2, latitude: -33.87, longitude: 151.21),
        PhotoLocationPointDTO(id: 3, latitude: -17, longitude: 179.5),
    ]

    func testLoadShowsPointsAndRequestsLibraryFiltersWithoutBounds() async {
        let api = TestAPI()
        await api.setLocations(LocationsResponseDTO(points: points, total: 3))
        let filters = LibraryFilters(flag: .pick, bounds: PhotoBounds(north: 1, south: 0, east: 1, west: 0))
        let store = MapStore(filters: filters, api: api)

        XCTAssertEqual(store.state, .idle)
        await store.load()

        XCTAssertEqual(store.state, .loaded)
        XCTAssertEqual(store.points, points)
        XCTAssertEqual(store.pointsVersion, 1)
        XCTAssertEqual(store.visibleCount, 3)
        XCTAssertNil(store.visibleAreaFilters)
        let queries = await api.recordedLocationQueries()
        XCTAssertEqual(queries, [LibraryFilters(flag: .pick).photoQuery])
    }

    func testNoGeotaggedPhotosIsEmpty() async {
        let api = TestAPI()
        let store = MapStore(filters: LibraryFilters(), api: api)
        await store.load()
        XCTAssertEqual(store.state, .empty)
        XCTAssertTrue(store.points.isEmpty)
    }

    func testFailureThenRetryLoads() async {
        let api = TestAPI()
        await api.setLocations(LocationsResponseDTO(points: [], total: 0), failure: .transport("The network connection was lost."))
        let store = MapStore(filters: LibraryFilters(), api: api)
        await store.load()
        XCTAssertEqual(store.state, .failed("The network connection was lost."))
        XCTAssertTrue(store.points.isEmpty)

        await api.setLocations(LocationsResponseDTO(points: points, total: 3))
        await store.load()
        XCTAssertEqual(store.state, .loaded)
        XCTAssertEqual(store.points.map(\.id), [1, 2, 3])
    }

    func testVisibleRegionCountsPointsAndScopesAreaFilters() async {
        let api = TestAPI()
        await api.setLocations(LocationsResponseDTO(points: points, total: 3))
        let store = MapStore(filters: LibraryFilters(mediaKind: .raw), api: api)
        await store.load()

        let pacific = PhotoBounds(north: 0, south: -40, east: -170, west: 150)
        store.setVisibleBounds(pacific)
        XCTAssertEqual(store.visibleCount, 2)
        XCTAssertEqual(store.visibleAreaFilters, LibraryFilters(mediaKind: .raw, bounds: pacific))
        XCTAssertNil(store.filters.bounds, "The map itself keeps covering the whole world")
    }

    func testOpenPhotoLoadsRecordForLoupe() async {
        let api = TestAPI()
        await api.setPhotos(PhotosResponseDTO(photos: [TestModels.photo(id: 2)], total: 1, rawCount: 0))
        let store = MapStore(filters: LibraryFilters(), api: api)

        await store.openPhoto(id: 2)
        XCTAssertEqual(store.openRecord?.id, 2)
        XCTAssertFalse(store.isOpeningPhoto)
        XCTAssertNil(store.openError)

        await store.openPhoto(id: 99)
        XCTAssertEqual(store.openError, "Photo not found")
    }
}
