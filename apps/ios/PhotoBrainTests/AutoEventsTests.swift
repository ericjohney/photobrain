import XCTest
@testable import PhotoBrain

private let usEnglish = Locale(identifier: "en_US")
private let baseURL = URL(string: "https://photos.example.invalid")!

private func event(
    id: Int = 11,
    startAt: String = "2023-10-03T09:15:00",
    endAt: String = "2023-10-05T21:40:00",
    photoCount: Int = 12,
    coverID: Int = 42,
    place: EventPlaceDTO? = nil
) -> EventDTO {
    EventDTO(
        id: id,
        startAt: startAt,
        endAt: endAt,
        photoCount: photoCount,
        cover: CollectionCoverDTO(photoId: coverID, thumbnailUpdatedAt: nil),
        place: place
    )
}

private let kyoto = EventPlaceDTO(city: "Kyoto", region: "Kyoto", country: "Japan", countryCode: "JP")

final class EventsAPITests: XCTestCase {
    private let decoder = APIModelCoding.decoder()

    override func tearDown() {
        StubURLProtocol.reset()
        super.tearDown()
    }

    func testResponseDecodesPlacesCoversAndNulls() throws {
        let json = #"{"events":["#
            + #"{"id":11,"startAt":"2023-10-03T09:15:00","endAt":"2023-10-05T21:40:00","photoCount":12,"#
            + #""cover":{"photoId":42,"thumbnailUpdatedAt":"2025-10-04T07:08:09.123Z"},"#
            + #""place":{"city":"Kyoto","region":"Kyoto","country":"Japan","countryCode":"JP"}},"#
            + #"{"id":3,"startAt":"2022-01-01T10:00:00","endAt":"2022-01-01T12:00:00","photoCount":6,"#
            + #""cover":{"photoId":4,"thumbnailUpdatedAt":null},"#
            + #""place":{"city":null,"region":null,"country":"France","countryCode":"FR"}},"#
            + #"{"id":1,"startAt":"2021-05-05T10:00:00","endAt":"2021-05-06T12:00:00","photoCount":7,"#
            + #""cover":{"photoId":1,"thumbnailUpdatedAt":null},"place":null}"#
            + "]}"

        let response = try decoder.decode(EventsResponseDTO.self, from: Data(json.utf8))

        XCTAssertEqual(response.events.map(\.id), [11, 3, 1])
        let first = response.events[0]
        XCTAssertEqual(first.startAt, "2023-10-03T09:15:00")
        XCTAssertEqual(first.endAt, "2023-10-05T21:40:00")
        XCTAssertEqual(first.photoCount, 12)
        XCTAssertEqual(first.cover.photoId, 42)
        XCTAssertNotNil(first.cover.thumbnailUpdatedAt)
        XCTAssertEqual(first.place, kyoto)
        XCTAssertNil(response.events[1].cover.thumbnailUpdatedAt)
        XCTAssertEqual(
            response.events[1].place,
            EventPlaceDTO(city: nil, region: nil, country: "France", countryCode: "FR")
        )
        XCTAssertNil(response.events[2].place)
        XCTAssertNotEqual(first.coverURL(apiBaseURL: baseURL), response.events[1].coverURL(apiBaseURL: baseURL))
    }

    func testEventsRequestSendsFolderOnlyWhenSet() async throws {
        StubURLProtocol.respond(status: 200, body: #"{"events":[]}"#)
        let client = StubURLProtocol.makeClient()

        _ = try await client.events(folder: nil)
        _ = try await client.events(folder: "2024/trip")

        let urls = StubURLProtocol.requests.compactMap(\.url)
        XCTAssertEqual(urls.map(\.path), ["/api/v1/events", "/api/v1/events"])
        XCTAssertNil(URLComponents(url: urls[0], resolvingAgainstBaseURL: false)?.queryItems)
        XCTAssertEqual(
            URLComponents(url: urls[1], resolvingAgainstBaseURL: false)?.queryItems,
            [URLQueryItem(name: "folder", value: "2024/trip")]
        )
    }

    func testEventQueryItemIsSentWhenSetAndOmittedWhenNil() {
        XCTAssertEqual(
            PhotoQuery(tag: "dog", event: 11).queryItems,
            [
                URLQueryItem(name: "filterRaw", value: "all"),
                URLQueryItem(name: "tag", value: "dog"),
                URLQueryItem(name: "event", value: "11"),
            ]
        )
        XCTAssertFalse(PhotoQuery(tag: "dog").queryItems.contains { $0.name == "event" })
    }

    func testEventIsSentInSearchBodyAndOmittedWhenNil() async throws {
        StubURLProtocol.respond(status: 200, body: #"{"photos":[],"total":0,"query":"cake"}"#)
        let client = StubURLProtocol.makeClient()

        _ = try await client.search(query: "cake", limit: 10, filters: PhotoQuery(event: 11))
        _ = try await client.search(query: "cake", limit: 10, filters: PhotoQuery())

        let bodies = try StubURLProtocol.requests.map { request in
            try XCTUnwrap(JSONSerialization.jsonObject(with: XCTUnwrap(request.httpBody)) as? [String: Any])
        }
        XCTAssertEqual(bodies[0]["event"] as? Int, 11)
        XCTAssertNil(bodies[1]["event"])
    }

    func testLocationsRequestCarriesEvent() async throws {
        StubURLProtocol.respond(status: 200, body: #"{"points":[],"total":0}"#)
        _ = try await StubURLProtocol.makeClient().locations(query: PhotoQuery(event: 11))

        let url = try XCTUnwrap(StubURLProtocol.requests.first?.url)
        XCTAssertEqual(url.path, "/api/v1/locations")
        XCTAssertTrue(
            URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems?
                .contains(URLQueryItem(name: "event", value: "11")) ?? false
        )
    }

    func testSimilarRequestCarriesEventOnlyWhenSet() async throws {
        StubURLProtocol.respond(status: 200, body: #"{"photos":[],"total":0,"sourcePhotoId":5,"indexed":true}"#)
        let client = StubURLProtocol.makeClient()

        _ = try await client.similarPhotos(id: 5, limit: 30, event: 11)
        _ = try await client.similarPhotos(id: 5, limit: 30)

        XCTAssertEqual(
            StubURLProtocol.requests.compactMap { $0.url?.query },
            ["limit=30&event=11", "limit=30"]
        )
    }
}

final class EventFormattingTests: XCTestCase {
    private var savedTimeZone: TimeZone!

    override func setUp() {
        super.setUp()
        savedTimeZone = NSTimeZone.default
    }

    override func tearDown() {
        NSTimeZone.default = savedTimeZone
        super.tearDown()
    }

    private func range(_ start: String, _ end: String) -> String {
        EventFormatting.dateRange(startAt: start, endAt: end, locale: usEnglish)
    }

    func testSameDay() {
        XCTAssertEqual(range("2023-10-03T00:00:00", "2023-10-03T23:59:59"), "Oct 3, 2023")
    }

    func testSameMonth() {
        XCTAssertEqual(range("2023-10-03T09:15:00", "2023-10-05T21:40:00"), "Oct 3 – 5, 2023")
    }

    func testSameYearAcrossMonths() {
        XCTAssertEqual(range("2023-09-30T18:00:00", "2023-10-02T08:00:00"), "Sep 30 – Oct 2, 2023")
    }

    func testCrossYear() {
        XCTAssertEqual(range("2023-12-30T22:00:00", "2024-01-02T01:00:00"), "Dec 30, 2023 – Jan 2, 2024")
    }

    func testRangeUsesPlainSpacesAroundEnDash() {
        let text = range("2023-10-03T09:15:00", "2023-10-05T21:40:00")
        XCTAssertFalse(text.unicodeScalars.contains { $0 == "\u{2009}" || $0 == "\u{202F}" })
        XCTAssertTrue(text.contains(" – "))
    }

    func testWallClockDaysIgnoreDeviceTimeZone() {
        for identifier in ["Pacific/Kiritimati", "America/Los_Angeles"] {
            NSTimeZone.default = TimeZone(identifier: identifier)!
            XCTAssertEqual(range("2023-10-03T00:00:00", "2023-10-03T23:59:59"), "Oct 3, 2023", identifier)
            XCTAssertEqual(range("2023-12-31T23:30:00", "2024-01-01T00:30:00"), "Dec 31, 2023 – Jan 1, 2024", identifier)
            XCTAssertEqual(
                EventFormatting.title(for: event(startAt: "2023-10-03T00:00:00", endAt: "2023-10-05T23:59:00"), locale: usEnglish),
                "Oct 3 – 5, 2023",
                identifier
            )
        }
    }

    func testRangeIsLocalized() {
        let text = EventFormatting.dateRange(
            startAt: "2023-10-03T09:15:00",
            endAt: "2023-10-03T10:00:00",
            locale: Locale(identifier: "de_DE")
        )
        XCTAssertEqual(text, "3. Okt. 2023")
    }

    func testUnparseableValuesAreShownAsSent() {
        XCTAssertEqual(range("garbage", "garbage"), "garbage")
        XCTAssertEqual(range("2023-02-29T10:00:00", "2023-03-01T10:00:00"), "2023-02-29T10:00:00 – 2023-03-01T10:00:00")
    }

    func testPlaceLabels() {
        XCTAssertEqual(EventFormatting.placeLabel(kyoto), "Kyoto, Japan")
        XCTAssertEqual(
            EventFormatting.placeLabel(EventPlaceDTO(city: nil, region: nil, country: "Japan", countryCode: "JP")),
            "Japan"
        )
        XCTAssertEqual(
            EventFormatting.placeLabel(EventPlaceDTO(city: "Singapore", region: nil, country: "Singapore", countryCode: "SG")),
            "Singapore"
        )
    }

    func testPlaceTitleSubtitleCarriesRangeAndCount() {
        let card = EventCard(event(photoCount: 12, place: kyoto), apiBaseURL: baseURL, locale: usEnglish)
        XCTAssertEqual(card.title, "Kyoto, Japan")
        XCTAssertEqual(card.subtitle, "Oct 3 – 5, 2023 · 12 photos")
        XCTAssertEqual(card.filter, EventFilter(id: 11, title: "Kyoto, Japan"))
        XCTAssertEqual(card.coverPhotoID, 42)
    }

    func testDateTitleSubtitleIsOnlyCount() {
        let card = EventCard(event(photoCount: 1_234), apiBaseURL: baseURL, locale: usEnglish)
        XCTAssertEqual(card.title, "Oct 3 – 5, 2023")
        XCTAssertEqual(card.subtitle, "\(1_234.formatted()) photos")
        XCTAssertEqual(EventFormatting.subtitle(for: event(photoCount: 1), locale: usEnglish), "1 photo")
    }
}

final class EventFilterTests: XCTestCase {
    private let filter = EventFilter(id: 11, title: "Kyoto, Japan")

    func testEventIsActiveChipAndQuery() {
        let filters = LibraryFilters(minRating: 3, event: filter)
        XCTAssertTrue(LibraryFilters(event: filter).isActive)
        XCTAssertEqual(filters.activeFields.map(\.field), [.minRating, .event])
        XCTAssertEqual(filters.activeFields.last?.title, "Kyoto, Japan")
        XCTAssertEqual(filters.photoQuery, PhotoQuery(minRating: 3, event: 11))
    }

    func testRemovingEventReturnsToLibrary() {
        let filters = LibraryFilters(event: filter)
        XCTAssertFalse(filters.removing(.event).isActive)
        XCTAssertEqual(filters.removing(.event).photoQuery, PhotoQuery())
    }

    func testSmartAlbumsNeverSaveEvent() throws {
        let filters = LibraryFilters(mediaKind: .raw, tag: "dog", event: filter)
        XCTAssertEqual(filters.savableCriteria, LibraryFilters(mediaKind: .raw, tag: "dog"))
        let criteria = SmartAlbumFilters(filters)
        XCTAssertEqual(criteria, SmartAlbumFilters(filterRaw: .raw, tag: "dog"))
        XCTAssertNil(criteria.photoQuery.event)
        let encoded = String(decoding: try JSONEncoder().encode(criteria), as: UTF8.self)
        XCTAssertFalse(encoded.contains("event"))
    }
}

@MainActor
final class EventsStoreTests: XCTestCase {
    func testLoadListsEventsAsCards() async {
        let api = TestAPI()
        await api.setEvents(.success(EventsResponseDTO(events: [event(id: 11, place: kyoto), event(id: 3)])))
        let store = EventsStore(api: api)

        await store.loadIfNeeded()

        XCTAssertEqual(store.loadState, .loaded)
        XCTAssertEqual(store.events.map(\.id), [11, 3])
        XCTAssertEqual(store.cards(apiBaseURL: baseURL, locale: usEnglish).map(\.title), ["Kyoto, Japan", "Oct 3 – 5, 2023"])
        let requests = await api.recordedEventsRequests()
        XCTAssertEqual(requests, [nil])

        await store.loadIfNeeded()
        let count = await api.recordedEventsRequests().count
        XCTAssertEqual(count, 1, "A loaded list is not refetched until refresh")
    }

    func testFirstLoadFailureIsFailedStateAndRetryRecovers() async {
        let api = TestAPI()
        await api.setEvents(.failure(.server(status: 500, code: "INTERNAL", message: "Boom")))
        let store = EventsStore(api: api)

        await store.load()

        guard case .failed = store.loadState else { return XCTFail("Expected failed, got \(store.loadState)") }
        XCTAssertTrue(store.events.isEmpty)
        XCTAssertNil(store.errorMessage)

        await api.setEvents(.success(EventsResponseDTO(events: [event()])))
        await store.loadIfNeeded()
        XCTAssertEqual(store.loadState, .loaded)
        XCTAssertEqual(store.events.map(\.id), [11])
    }

    func testRefreshFailureKeepsListAndSurfacesError() async {
        let api = TestAPI()
        await api.setEvents(.success(EventsResponseDTO(events: [event()])))
        let store = EventsStore(api: api)
        await store.load()

        await api.setEvents(.failure(.server(status: 500, code: "INTERNAL", message: "Boom")))
        await store.load()

        XCTAssertEqual(store.loadState, .loaded)
        XCTAssertEqual(store.events.map(\.id), [11])
        XCTAssertNotNil(store.errorMessage)
        store.dismissError()
        XCTAssertNil(store.errorMessage)
    }

    func testRefreshReplacesList() async {
        let api = TestAPI()
        await api.setEvents(.success(EventsResponseDTO(events: [event(id: 11)])))
        let store = EventsStore(api: api)
        await store.load()

        await api.setEvents(.success(EventsResponseDTO(events: [])))
        await store.load()

        XCTAssertEqual(store.loadState, .loaded)
        XCTAssertTrue(store.events.isEmpty)
    }

    func testDetailScopeListsTheEventsMembers() async {
        let api = TestAPI()
        await api.setPhotos(PhotosResponseDTO(photos: [TestModels.photo(id: 5), TestModels.photo(id: 6)], total: 2, rawCount: 0))
        let card = EventCard(event(id: 11, place: kyoto), apiBaseURL: baseURL, locale: usEnglish)
        let detail = LibraryStore.event(card.filter, api: api)

        await detail.load()

        let queries = await api.recordedPhotoQueries()
        XCTAssertEqual(queries, [PhotoQuery(event: 11)])
        XCTAssertEqual(PhotoQuery(event: 11).queryItems.last, URLQueryItem(name: "event", value: "11"))
        XCTAssertEqual(detail.scope, .event)
        XCTAssertEqual(detail.filters.activeFields.map(\.title), ["Kyoto, Japan"])
        XCTAssertEqual(Set(detail.orderedRecords.map(\.id)), [5, 6])
    }
}
