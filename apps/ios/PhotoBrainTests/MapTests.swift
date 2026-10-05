import MapKit
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
    /// The Mercator rectangle spanning the given coordinate edges, with `east` unwrapped past
    /// 180 when the rectangle crosses the antimeridian.
    private func rect(north: Double, south: Double, west: Double, east: Double) -> MKMapRect {
        let topLeft = MKMapPoint(CLLocationCoordinate2D(latitude: north, longitude: west))
        let bottom = MKMapPoint(CLLocationCoordinate2D(latitude: south, longitude: west)).y
        let width = (east - west) / 360 * MKMapRect.world.width
        return MKMapRect(x: topLeft.x, y: topLeft.y, width: width, height: bottom - topLeft.y)
    }

    private func assertBounds(_ actual: PhotoBounds, _ expected: PhotoBounds, file: StaticString = #filePath, line: UInt = #line) {
        XCTAssertEqual(actual.north, expected.north, accuracy: 1e-6, file: file, line: line)
        XCTAssertEqual(actual.south, expected.south, accuracy: 1e-6, file: file, line: line)
        XCTAssertEqual(actual.east, expected.east, accuracy: 1e-6, file: file, line: line)
        XCTAssertEqual(actual.west, expected.west, accuracy: 1e-6, file: file, line: line)
    }

    func testRectWithinOneHemisphereKeepsWestBelowEast() {
        let bounds = MapRegionBounds.bounds(visibleMapRect: rect(north: 38, south: 36, west: -124, east: -120))
        assertBounds(bounds, PhotoBounds(north: 38, south: 36, east: -120, west: -124))
    }

    /// At continent scale Mercator stretches latitude unevenly, so the visible edges are not
    /// symmetric about the center (the old `MKCoordinateRegion` span reading was); the
    /// conversion must return the rectangle's real edges.
    func testContinentScaleRectKeepsAsymmetricMercatorEdges() {
        let bounds = MapRegionBounds.bounds(visibleMapRect: rect(north: 79.19, south: -34.42, west: -116.74, east: -14.43))
        assertBounds(bounds, PhotoBounds(north: 79.19, south: -34.42, east: -14.43, west: -116.74))
    }

    func testRectCrossingAntimeridianWrapsWithWestAboveEast() {
        let bounds = MapRegionBounds.bounds(visibleMapRect: rect(north: -15, south: -19, west: 173, east: 183))
        assertBounds(bounds, PhotoBounds(north: -15, south: -19, east: -177, west: 173))
        XCTAssertTrue(bounds.contains(latitude: -17, longitude: 179.5))
        XCTAssertTrue(bounds.contains(latitude: -17, longitude: -179.5))
        XCTAssertFalse(bounds.contains(latitude: -17, longitude: 0))
    }

    func testEastEdgeOnAntimeridianClosesAt180() {
        let bounds = MapRegionBounds.bounds(visibleMapRect: rect(north: 1, south: -1, west: 160, east: 180))
        XCTAssertEqual(bounds.west, 160, accuracy: 1e-6)
        XCTAssertEqual(bounds.east, 180)
    }

    func testWholeWorldRectClampsLatitudeAndCoversAllLongitudes() {
        let world = MKMapRect.world
        let bounds = MapRegionBounds.bounds(visibleMapRect: MKMapRect(x: -100, y: -100, width: world.width * 1.5, height: world.height + 200))
        XCTAssertEqual(bounds.east, 180)
        XCTAssertEqual(bounds.west, -180)
        XCTAssertTrue(bounds.contains(latitude: 85, longitude: 0))
        XCTAssertTrue(bounds.contains(latitude: -85, longitude: 0))
    }

    func testDensestSpanPicksLargerOfTwoDistantGroups() {
        // Two at x≈100, three at x≈500; a 50-wide window holds one group.
        let picked = MapFit.densestSpan(xs: [500, 100, 510, 105, 520], width: 50, worldWidth: 1000)
        XCTAssertEqual(Set(picked), [0, 2, 4])
    }

    func testDensestSpanWrapsAcrossAntimeridian() {
        // 990 and 5 are 15 apart across the wrap; the window must join them.
        let picked = MapFit.densestSpan(xs: [990, 5, 400, 995], width: 20, worldWidth: 1000)
        XCTAssertEqual(Set(picked), [0, 1, 3])
    }

    func testDensestSpanKeepsEveryPointWhenAllFit() {
        let picked = MapFit.densestSpan(xs: [10, 30, 20], width: 20, worldWidth: 1000)
        XCTAssertEqual(Set(picked), [0, 1, 2])
    }

    func testDensestSpanTieKeepsWesternmostGroup() {
        let picked = MapFit.densestSpan(xs: [700, 100, 710, 110], width: 50, worldWidth: 1000)
        XCTAssertEqual(Set(picked), [1, 3])
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
