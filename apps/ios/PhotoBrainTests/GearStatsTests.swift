import XCTest
@testable import PhotoBrain

private let gearJSON = #"""
{"total":12,"withExif":10,
"cameras":[{"label":"Canon EOS R5","count":7},{"label":"iPhone 15 Pro","count":3}],
"lenses":[{"label":"RF24-70mm F2.8 L IS USM","count":6}],
"focalLengths":[
{"label":"≤15 mm","min":null,"max":15,"count":0},
{"label":"16–23 mm","min":16,"max":23,"count":1},
{"label":"24–34 mm","min":24,"max":34,"count":2},
{"label":"35–49 mm","min":35,"max":49,"count":3},
{"label":"50–84 mm","min":50,"max":84,"count":0},
{"label":"85–134 mm","min":85,"max":134,"count":0},
{"label":"135–299 mm","min":135,"max":299,"count":4},
{"label":"≥300 mm","min":300,"max":null,"count":0}],
"apertures":[
{"label":"≤f/1.9","min":null,"max":1.9,"count":1},
{"label":"f/2–2.7","min":2,"max":2.7,"count":0},
{"label":"f/2.8–3.9","min":2.8,"max":3.9,"count":5},
{"label":"f/4–5.5","min":4,"max":5.5,"count":0},
{"label":"f/5.6–7.9","min":5.6,"max":7.9,"count":0},
{"label":"f/8–10.9","min":8,"max":10.9,"count":2},
{"label":"≥f/11","min":11,"max":null,"count":0}],
"shutterSpeeds":[
{"label":"≤1/2000 s","min":null,"max":0.0005,"count":0},
{"label":"1/1000–1/500 s","min":0.0005,"max":0.002,"count":2},
{"label":"1/250–1/125 s","min":0.002,"max":0.008,"count":4},
{"label":"1/60–1/30 s","min":0.008,"max":0.0334,"count":1},
{"label":"1/15–1/2 s","min":0.0334,"max":0.5,"count":0},
{"label":">1/2 s","min":0.5,"max":null,"count":1}],
"isos":[
{"label":"≤200","min":null,"max":200,"count":3},
{"label":"400","min":201,"max":400,"count":0},
{"label":"800","min":401,"max":800,"count":2},
{"label":"1600","min":801,"max":1600,"count":0},
{"label":"3200","min":1601,"max":3200,"count":0},
{"label":"6400","min":3201,"max":6400,"count":0},
{"label":">6400","min":6401,"max":null,"count":1}],
"cameraYears":[{"camera":"Canon EOS R5","year":2022,"count":4},{"camera":"iPhone 15 Pro","year":2023,"count":3}]}
"""#

private func count(_ label: String, _ count: Int) -> GearCountDTO {
    GearCountDTO(label: label, count: count)
}

private func year(_ camera: String, _ year: Int, _ count: Int) -> GearCameraYearDTO {
    GearCameraYearDTO(camera: camera, year: year, count: count)
}

/// Every filter the Library can send, including the view scopes.
private let everyFilter = LibraryFilters(
    mediaKind: .raw,
    camera: "Canon EOS R5",
    lens: "RF24-70mm F2.8 L IS USM",
    iso: 400,
    dateMonth: "2023-10",
    minRating: 3,
    flag: .pick,
    tag: "night-sky",
    country: PlaceCountryFilter(code: "JP", name: "Japan"),
    place: PlaceCityFilter(id: 1_857_910, name: "Kyoto", region: "Kyoto", countryCode: "JP"),
    bounds: PhotoBounds(north: 35.1, south: 34.9, east: 135.9, west: 135.6),
    capturedDate: "2023-10-03",
    event: EventFilter(id: 11, title: "Kyoto, Japan")
)

final class GearStatsAPITests: XCTestCase {
    override func tearDown() {
        StubURLProtocol.reset()
        super.tearDown()
    }

    func testDecodesEveryBucketWithZeroCountsAndOpenBounds() throws {
        let stats = try APIModelCoding.decoder().decode(GearStatsDTO.self, from: Data(gearJSON.utf8))

        XCTAssertEqual(stats.total, 12)
        XCTAssertEqual(stats.withExif, 10)
        XCTAssertEqual(stats.cameras, [count("Canon EOS R5", 7), count("iPhone 15 Pro", 3)])
        XCTAssertEqual(stats.lenses, [count("RF24-70mm F2.8 L IS USM", 6)])
        XCTAssertEqual(stats.focalLengths.map(\.label), ["≤15 mm", "16–23 mm", "24–34 mm", "35–49 mm", "50–84 mm", "85–134 mm", "135–299 mm", "≥300 mm"])
        XCTAssertEqual(stats.focalLengths.map(\.count), [0, 1, 2, 3, 0, 0, 4, 0])
        XCTAssertEqual(stats.apertures.count, 7)
        XCTAssertEqual(stats.shutterSpeeds.count, 6)
        XCTAssertEqual(stats.isos.count, 7)

        XCTAssertEqual(stats.focalLengths.first, GearBucketDTO(label: "≤15 mm", min: nil, max: 15, count: 0))
        XCTAssertEqual(stats.focalLengths.last, GearBucketDTO(label: "≥300 mm", min: 300, max: nil, count: 0))
        XCTAssertEqual(stats.apertures[2], GearBucketDTO(label: "f/2.8–3.9", min: 2.8, max: 3.9, count: 5))
        XCTAssertEqual(stats.shutterSpeeds[0], GearBucketDTO(label: "≤1/2000 s", min: nil, max: 0.0005, count: 0))
        XCTAssertEqual(stats.shutterSpeeds[3], GearBucketDTO(label: "1/60–1/30 s", min: 0.008, max: 0.0334, count: 1))
        XCTAssertEqual(stats.isos.last, GearBucketDTO(label: ">6400", min: 6401, max: nil, count: 1))
        XCTAssertEqual(stats.cameraYears, [year("Canon EOS R5", 2022, 4), year("iPhone 15 Pro", 2023, 3)])
    }

    func testDecodesEmptyLibrary() throws {
        let json = #"{"total":0,"withExif":0,"cameras":[],"lenses":[],"focalLengths":[],"apertures":[],"#
            + #""shutterSpeeds":[],"isos":[],"cameraYears":[]}"#
        let stats = try APIModelCoding.decoder().decode(GearStatsDTO.self, from: Data(json.utf8))
        XCTAssertEqual(stats.total, 0)
        XCTAssertTrue(stats.cameras.isEmpty && stats.cameraYears.isEmpty)
    }

    func testRequestSendsExactlyThePhotosQueryItems() async throws {
        let client = StubURLProtocol.makeClient()
        for filters in [LibraryFilters(), everyFilter] {
            StubURLProtocol.reset()
            StubURLProtocol.respond(status: 200, body: #"{"photos":[],"total":0,"rawCount":0}"#)
            _ = try await client.photos(query: filters.photoQuery)
            StubURLProtocol.respond(status: 200, body: gearJSON)
            _ = try await client.gearStats(query: filters.photoQuery)

            let urls = StubURLProtocol.requests.compactMap(\.url)
            XCTAssertEqual(urls.map(\.path), ["/api/v1/photos", "/api/v1/gear-stats"])
            let photosItems = URLComponents(url: urls[0], resolvingAgainstBaseURL: false)?.queryItems
            let gearItems = URLComponents(url: urls[1], resolvingAgainstBaseURL: false)?.queryItems
            XCTAssertNotNil(gearItems)
            XCTAssertEqual(gearItems, photosItems)
        }
        let urls = StubURLProtocol.requests.compactMap(\.url)
        XCTAssertEqual(
            URLComponents(url: urls[1], resolvingAgainstBaseURL: false)?.queryItems?.map(\.name),
            ["filterRaw", "camera", "lens", "iso", "dateMonth", "minRating", "flag", "tag", "country", "place",
             "north", "south", "east", "west", "capturedDate", "event"]
        )
    }

    func testServerErrorSurfaces() async {
        StubURLProtocol.respond(status: 500, body: #"{"error":{"code":"INTERNAL","message":"Boom"}}"#)
        do {
            _ = try await StubURLProtocol.makeClient().gearStats(query: PhotoQuery())
            XCTFail("Expected an error")
        } catch {
            XCTAssertTrue(error is PhotoBrainAPIError)
        }
    }
}

final class GearStatsPresentationTests: XCTestCase {
    func testHeaderTextIsSingularAndPlural() {
        XCTAssertEqual(GearStatsPresentation.headerText(total: 1, withExif: 0), "1 photo · 0 with camera data")
        XCTAssertEqual(GearStatsPresentation.headerText(total: 1, withExif: 1), "1 photo · 1 with camera data")
        XCTAssertEqual(
            GearStatsPresentation.headerText(total: 12_345, withExif: 1_000),
            "\(12_345.formatted()) photos · \(1_000.formatted()) with camera data"
        )
    }

    func testBucketAccessibilityLabels() {
        let bucket = { (count: Int) in GearBucketDTO(label: "35–49 mm", min: 35, max: 49, count: count) }
        XCTAssertEqual(GearStatsPresentation.accessibilityLabel(bucket(120)), "35–49 mm: 120 photos")
        XCTAssertEqual(GearStatsPresentation.accessibilityLabel(bucket(1)), "35–49 mm: 1 photo")
        XCTAssertEqual(GearStatsPresentation.accessibilityLabel(bucket(0)), "35–49 mm: 0 photos")
        XCTAssertEqual(GearStatsPresentation.accessibilityLabel(count("Canon EOS R5", 1)), "Canon EOS R5: 1 photo")
    }

    func testTopTenUntilShowAll() {
        let eleven = (1...11).map { count("Camera \($0)", 12 - $0) }
        XCTAssertEqual(GearStatsPresentation.visible(eleven, showAll: false).map(\.label), (1...10).map { "Camera \($0)" })
        XCTAssertEqual(GearStatsPresentation.visible(eleven, showAll: true).count, 11)
        XCTAssertTrue(GearStatsPresentation.hasMore(eleven))

        let ten = Array(eleven.prefix(10))
        XCTAssertEqual(GearStatsPresentation.visible(ten, showAll: false).count, 10)
        XCTAssertFalse(GearStatsPresentation.hasMore(ten))
        XCTAssertTrue(GearStatsPresentation.visible([], showAll: false).isEmpty)
    }

    func testBarFractionScalesToMaximumAndHandlesZero() {
        XCTAssertEqual(GearStatsPresentation.fraction(5, of: 10), 0.5)
        XCTAssertEqual(GearStatsPresentation.fraction(0, of: 10), 0)
        XCTAssertEqual(GearStatsPresentation.fraction(0, of: 0), 0)
    }

    func testNoCameraYearsIsEmpty() {
        let breakdown = GearStatsPresentation.yearBreakdown([])
        XCTAssertTrue(breakdown.isEmpty)
        XCTAssertEqual(breakdown.maximumTotal, 0)
        XCTAssertFalse(breakdown.hasOther)
    }

    func testFiveOrFewerCamerasHaveNoOther() {
        let breakdown = GearStatsPresentation.yearBreakdown([
            year("B", 2021, 2),
            year("A", 2021, 2),
            year("A", 2022, 1),
        ])
        XCTAssertEqual(breakdown.cameras, ["A", "B"], "Ties by total break by name")
        XCTAssertFalse(breakdown.hasOther)
        XCTAssertEqual(breakdown.years.map(\.year), [2021, 2022])
        XCTAssertEqual(breakdown.years[0].segments.map(\.label), ["A", "B"])
        XCTAssertEqual(breakdown.years[1].segments.map(\.label), ["A"], "Zero segments are omitted")
        XCTAssertEqual(breakdown.maximumTotal, 4)
    }

    func testCamerasBeyondTopFiveByTotalAreGroupedAsOther() {
        // Totals: A 10, B 9, C 8, D 7, E 6, F 5, G 5. F and G fall outside the top five.
        let breakdown = GearStatsPresentation.yearBreakdown([
            year("A", 2020, 10),
            year("F", 2020, 5),
            year("B", 2021, 9),
            year("C", 2021, 8),
            year("G", 2021, 5),
            year("D", 2022, 7),
            year("E", 2022, 6),
        ])

        XCTAssertEqual(breakdown.cameras, ["A", "B", "C", "D", "E"])
        XCTAssertTrue(breakdown.hasOther)
        XCTAssertEqual(breakdown.years.map(\.year), [2020, 2021, 2022])
        XCTAssertEqual(breakdown.years.map(\.total), [15, 22, 13])
        XCTAssertEqual(
            breakdown.years[1].segments,
            [
                .init(cameraIndex: 1, label: "B", count: 9),
                .init(cameraIndex: 2, label: "C", count: 8),
                .init(cameraIndex: nil, label: "Other", count: 5),
            ]
        )
        XCTAssertEqual(breakdown.years[2].segments.map(\.label), ["D", "E"], "A year without other cameras has no Other")
        XCTAssertEqual(breakdown.maximumTotal, 22)
    }

    func testCameraRankUsesTotalsAcrossYearsNotOneYear() {
        // B has the biggest single year, but A shoots more overall.
        let breakdown = GearStatsPresentation.yearBreakdown([
            year("A", 2020, 4), year("A", 2021, 4),
            year("B", 2021, 6),
        ])
        XCTAssertEqual(breakdown.cameras, ["A", "B"])
    }

    func testYearAccessibilityLabel() {
        let breakdown = GearStatsPresentation.yearBreakdown([year("A", 2023, 1)])
        XCTAssertEqual(breakdown.years[0].accessibilityLabel, "2023: 1 photo; A 1")

        let grouped = GearStatsPresentation.yearBreakdown(
            [year("A", 2024, 6), year("B", 2024, 5), year("C", 2024, 4), year("D", 2024, 3), year("E", 2024, 2), year("F", 2024, 1)]
        )
        XCTAssertEqual(grouped.years[0].accessibilityLabel, "2024: 21 photos; A 6, B 5, C 4, D 3, E 2, Other 1")
    }
}

@MainActor
final class GearStatsStoreTests: XCTestCase {
    func testLoadsStatsForTheLibrarysExactListingQuery() async {
        let api = TestAPI()
        await api.setPhotos(PhotosResponseDTO(photos: [TestModels.photo(id: 1)], total: 1, rawCount: 1))
        await api.setGearStats(.success(TestModels.gearStats(total: 1, withExif: 1, cameras: [count("Canon EOS R5", 1)])))
        let library = LibraryStore(api: api, filters: everyFilter)
        await library.load()

        let store = GearStatsStore(filters: library.filters, api: api)
        XCTAssertEqual(store.state, .idle)
        await store.load()

        XCTAssertEqual(store.state, .loaded)
        XCTAssertEqual(store.stats?.cameras, [count("Canon EOS R5", 1)])
        let gearQueries = await api.recordedGearStatsQueries()
        let photoQueries = await api.recordedPhotoQueries()
        XCTAssertEqual(gearQueries, photoQueries)
        XCTAssertEqual(gearQueries.first?.queryItems, photoQueries.first?.queryItems)
    }

    func testZeroTotalIsEmpty() async {
        let api = TestAPI()
        await api.setGearStats(.success(TestModels.gearStats(total: 0)))
        let store = GearStatsStore(filters: LibraryFilters(camera: "Gone"), api: api)

        await store.load()

        XCTAssertEqual(store.state, .empty)
        XCTAssertEqual(store.stats?.total, 0)
    }

    func testPhotosWithoutCameraDataStillLoad() async {
        let api = TestAPI()
        await api.setGearStats(.success(TestModels.gearStats(total: 4, withExif: 0)))
        let store = GearStatsStore(filters: LibraryFilters(), api: api)

        await store.load()

        XCTAssertEqual(store.state, .loaded)
        XCTAssertTrue(GearStatsPresentation.yearBreakdown(store.stats?.cameraYears ?? []).isEmpty)
    }

    func testFailureIsFailedStateAndRetryRecovers() async {
        let api = TestAPI()
        await api.setGearStats(.failure(.server(status: 500, code: "INTERNAL", message: "Boom")))
        let store = GearStatsStore(filters: LibraryFilters(), api: api)

        await store.load()

        guard case let .failed(message) = store.state else { return XCTFail("Expected failed, got \(store.state)") }
        XCTAssertFalse(message.isEmpty)
        XCTAssertNil(store.stats)

        await api.setGearStats(.success(TestModels.gearStats(total: 2, withExif: 2)))
        await store.load()
        XCTAssertEqual(store.state, .loaded)
        XCTAssertEqual(store.stats?.total, 2)
        let requests = await api.recordedGearStatsQueries()
        XCTAssertEqual(requests.count, 2)
    }

    func testTappingACameraReplacesOnlyTheCameraFilterAndReloads() async throws {
        let api = TestAPI()
        let library = LibraryStore(api: api, filters: LibraryFilters(camera: "Old Camera", lens: "50mm", iso: 400))
        await library.load()

        library.showGear(.camera("Canon EOS R5"))

        XCTAssertEqual(library.filters, LibraryFilters(camera: "Canon EOS R5", lens: "50mm", iso: 400))
        try await waitForLastQuery(PhotoQuery(camera: "Canon EOS R5", lens: "50mm", iso: 400), api: api)
    }

    func testTappingALensAppliesTheLensFilterAndReloads() async throws {
        let api = TestAPI()
        let library = LibraryStore(api: api, filters: LibraryFilters(mediaKind: .raw))
        await library.load()

        library.showGear(.lens("RF24-70mm F2.8 L IS USM"))

        XCTAssertEqual(library.filters, LibraryFilters(mediaKind: .raw, lens: "RF24-70mm F2.8 L IS USM"))
        XCTAssertEqual(library.filters.activeFields.map(\.field), [.mediaKind, .lens])
        try await waitForLastQuery(PhotoQuery(filterRaw: .raw, lens: "RF24-70mm F2.8 L IS USM"), api: api)
    }

    private func waitForLastQuery(_ expected: PhotoQuery, api: TestAPI, file: StaticString = #filePath, line: UInt = #line) async throws {
        let deadline = ContinuousClock.now + .seconds(3)
        while await api.recordedPhotoQueries().last != expected {
            guard ContinuousClock.now < deadline else {
                let last = await api.recordedPhotoQueries().last
                XCTFail("Last query \(String(describing: last)) != \(expected)", file: file, line: line)
                return
            }
            try await Task.sleep(for: .milliseconds(10))
        }
    }
}
