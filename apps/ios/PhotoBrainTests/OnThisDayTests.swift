import XCTest
@testable import PhotoBrain

private let usEnglish = Locale(identifier: "en_US")
private let baseURL = URL(string: "https://photos.example.invalid")!

private func group(year: Int, yearsAgo: Int, capturedDate: String, count: Int, coverID: Int = 7) -> OnThisDayYearDTO {
    OnThisDayYearDTO(
        year: year,
        yearsAgo: yearsAgo,
        capturedDate: capturedDate,
        count: count,
        cover: CollectionCoverDTO(photoId: coverID, thumbnailUpdatedAt: nil)
    )
}

private func utc(_ value: String) -> Date {
    ISO8601DateFormatter().date(from: value)!
}

/// Mutable clock for injecting "now" into `OnThisDayStore`.
private final class TestClock: @unchecked Sendable {
    private let lock = NSLock()
    private var current: Date

    init(_ date: Date) { current = date }

    var now: Date {
        lock.lock()
        defer { lock.unlock() }
        return current
    }

    func set(_ date: Date) {
        lock.lock()
        current = date
        lock.unlock()
    }
}

final class OnThisDayAPITests: XCTestCase {
    private let decoder = APIModelCoding.decoder()

    override func tearDown() {
        StubURLProtocol.reset()
        super.tearDown()
    }

    func testResponseDecodesYearsAndCovers() throws {
        let json = #"{"date":"2026-10-03","years":["#
            + #"{"year":2025,"yearsAgo":1,"capturedDate":"2025-10-03","count":12,"#
            + #""cover":{"photoId":42,"thumbnailUpdatedAt":"2025-10-04T07:08:09.123Z"}},"#
            + #"{"year":2019,"yearsAgo":7,"capturedDate":"2019-10-03","count":1,"#
            + #""cover":{"photoId":5,"thumbnailUpdatedAt":null}}]}"#
        let response = try decoder.decode(OnThisDayResponseDTO.self, from: Data(json.utf8))

        XCTAssertEqual(response.date, "2026-10-03")
        XCTAssertEqual(response.years.map(\.year), [2025, 2019])
        XCTAssertEqual(response.years.map(\.yearsAgo), [1, 7])
        XCTAssertEqual(response.years.map(\.capturedDate), ["2025-10-03", "2019-10-03"])
        XCTAssertEqual(response.years.map(\.count), [12, 1])
        XCTAssertEqual(response.years[0].cover.photoId, 42)
        XCTAssertEqual(try XCTUnwrap(response.years[0].cover.thumbnailUpdatedAt).timeIntervalSince1970, 1_759_561_689.123, accuracy: 0.0005)
        XCTAssertNil(response.years[1].cover.thumbnailUpdatedAt)

        let versioned = response.years[0].coverURL(apiBaseURL: baseURL)
        XCTAssertEqual(versioned.path, "/api/photos/42/thumbnail/small")
        XCTAssertEqual(versioned.query, "v=1759561689123")
        XCTAssertNil(response.years[1].coverURL(apiBaseURL: baseURL).query)
    }

    func testEmptyResponseDecodes() throws {
        let response = try decoder.decode(OnThisDayResponseDTO.self, from: Data(#"{"date":"2026-10-03","years":[]}"#.utf8))
        XCTAssertTrue(response.years.isEmpty)
    }

    func testOnThisDaySendsDeviceLocalDate() async throws {
        StubURLProtocol.respond(status: 200, body: #"{"date":"2026-10-03","years":[]}"#)
        let now = utc("2026-10-03T12:00:00Z")
        _ = try await StubURLProtocol.makeClient().onThisDay(date: now)

        let request = try XCTUnwrap(StubURLProtocol.requests.first)
        XCTAssertEqual(request.httpMethod, "GET")
        XCTAssertEqual(request.url?.path, "/api/v1/on-this-day")
        XCTAssertEqual(try queryItems(of: request), [
            URLQueryItem(name: "date", value: OnThisDayDate.localDayString(now, timeZone: .current)),
        ])
    }

    func testOnThisDayMapsServerError() async {
        StubURLProtocol.respond(status: 400, body: #"{"error":{"code":"INVALID_DATE","message":"Invalid date"}}"#)
        do {
            _ = try await StubURLProtocol.makeClient().onThisDay(date: Date())
            XCTFail("Expected a server error")
        } catch {
            XCTAssertEqual(error as? PhotoBrainAPIError, .server(status: 400, code: "INVALID_DATE", message: "Invalid date"))
        }
    }

    func testCapturedDateIsEncodedIntoPhotosQueryAfterTag() async throws {
        StubURLProtocol.respond(status: 200, body: #"{"photos":[],"total":0,"rawCount":0}"#)
        _ = try await StubURLProtocol.makeClient().photos(query: PhotoQuery(tag: "dog", capturedDate: "2023-10-03"))

        let items = try queryItems(of: XCTUnwrap(StubURLProtocol.requests.first))
        XCTAssertEqual(items.map(\.name), ["filterRaw", "tag", "capturedDate"])
        XCTAssertEqual(items.last?.value, "2023-10-03")
    }

    func testCapturedDateIsEncodedIntoLocationsQuery() async throws {
        StubURLProtocol.respond(status: 200, body: #"{"points":[],"total":0}"#)
        _ = try await StubURLProtocol.makeClient().locations(query: PhotoQuery(capturedDate: "2020-02-29"))

        let request = try XCTUnwrap(StubURLProtocol.requests.first)
        XCTAssertEqual(request.url?.path, "/api/v1/locations")
        XCTAssertEqual(try queryItems(of: request), [
            URLQueryItem(name: "filterRaw", value: "all"),
            URLQueryItem(name: "capturedDate", value: "2020-02-29"),
        ])
    }

    func testUnsetCapturedDateIsOmittedFromQuery() {
        XCTAssertEqual(PhotoQuery(tag: "dog").queryItems.map(\.name), ["filterRaw", "tag"])
    }

    func testCapturedDateIsSentInSearchBodyAndOmittedWhenNil() async throws {
        let body = try await sentSearchBody(filters: PhotoQuery(tag: "beach", capturedDate: "2023-10-03"))
        XCTAssertEqual(body["capturedDate"] as? String, "2023-10-03")
        XCTAssertEqual(body["tag"] as? String, "beach")

        StubURLProtocol.reset()
        let unset = try await sentSearchBody(filters: PhotoQuery(tag: "beach"))
        XCTAssertEqual(Set(unset.keys), ["query", "limit", "filterRaw", "tag"])
    }

    private func sentSearchBody(filters: PhotoQuery) async throws -> [String: Any] {
        StubURLProtocol.respond(status: 200, body: #"{"photos":[],"total":0,"query":"cake"}"#)
        _ = try await StubURLProtocol.makeClient().search(query: "cake", limit: 10, filters: filters)
        let data = try XCTUnwrap(XCTUnwrap(StubURLProtocol.requests.first).httpBody)
        return try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
    }

    private func queryItems(of request: URLRequest) throws -> [URLQueryItem] {
        URLComponents(url: try XCTUnwrap(request.url), resolvingAgainstBaseURL: false)?.queryItems ?? []
    }
}

final class OnThisDayDateTests: XCTestCase {
    private let berlin = TimeZone(identifier: "Europe/Berlin")!
    private let losAngeles = TimeZone(identifier: "America/Los_Angeles")!
    private let tokyo = TimeZone(identifier: "Asia/Tokyo")!

    func testLocalDayFlipsExactlyAtLocalMidnight() {
        // Berlin is UTC+2 in October: local midnight on Oct 3 is 22:00 UTC on Oct 2.
        XCTAssertEqual(OnThisDayDate.localDayString(utc("2026-10-02T21:59:59Z"), timeZone: berlin), "2026-10-02")
        XCTAssertEqual(OnThisDayDate.localDayString(utc("2026-10-02T22:00:00Z"), timeZone: berlin), "2026-10-03")
    }

    func testSameInstantIsADifferentDayInDifferentZones() {
        let instant = utc("2026-10-02T23:30:00Z")
        XCTAssertEqual(OnThisDayDate.localDayString(instant, timeZone: losAngeles), "2026-10-02")
        XCTAssertEqual(OnThisDayDate.localDayString(instant, timeZone: TimeZone(secondsFromGMT: 0)!), "2026-10-02")
        XCTAssertEqual(OnThisDayDate.localDayString(instant, timeZone: tokyo), "2026-10-03")
    }

    func testLocalDayUsesPaddedGregorianDigitsAcrossYearBoundary() {
        XCTAssertEqual(OnThisDayDate.localDayString(utc("2027-01-01T07:59:59Z"), timeZone: losAngeles), "2026-12-31")
        XCTAssertEqual(OnThisDayDate.localDayString(utc("2027-01-01T08:00:00Z"), timeZone: losAngeles), "2027-01-01")
    }

    func testDefaultZoneIsTheDevicesCurrentZone() {
        let instant = utc("2026-10-02T23:30:00Z")
        XCTAssertEqual(OnThisDayDate.localDayString(instant), OnThisDayDate.localDayString(instant, timeZone: .current))
    }

    func testStrictCalendarDateParsing() {
        XCTAssertEqual(OnThisDayDate.date(from: "2024-02-29"), utc("2024-02-29T00:00:00Z"))
        XCTAssertEqual(OnThisDayDate.date(from: "2023-10-03"), utc("2023-10-03T00:00:00Z"))
        for invalid in ["2023-02-29", "2024-13-01", "2024-00-10", "2024-04-31", "2024:10:03", "2024-1-03", "", "abcd-ef-gh"] {
            XCTAssertNil(OnThisDayDate.date(from: invalid), invalid)
        }
    }
}

final class OnThisDayCardTests: XCTestCase {
    func testOneYearAgoSingularPhoto() {
        let card = OnThisDayCard(group(year: 2025, yearsAgo: 1, capturedDate: "2025-10-03", count: 1, coverID: 9), apiBaseURL: baseURL, locale: usEnglish)
        XCTAssertEqual(card.yearsAgoText, "1 year ago")
        XCTAssertEqual(card.dateText, "Oct 3, 2025")
        XCTAssertEqual(card.countText, "1 photo")
        XCTAssertEqual(card.capturedDate, "2025-10-03")
        XCTAssertEqual(card.coverPhotoID, 9)
        XCTAssertEqual(card.coverURL.path, "/api/photos/9/thumbnail/small")
        XCTAssertEqual(card.accessibilityLabel, "1 year ago, Oct 3, 2025, 1 photo")
    }

    func testSeveralYearsAgoPluralPhotos() {
        let card = OnThisDayCard(group(year: 2023, yearsAgo: 3, capturedDate: "2023-10-03", count: 12), apiBaseURL: baseURL, locale: usEnglish)
        XCTAssertEqual(card.yearsAgoText, "3 years ago")
        XCTAssertEqual(card.dateText, "Oct 3, 2023")
        XCTAssertEqual(card.countText, "12 photos")
    }

    func testLeapDayCardShowsTheMatchedDate() {
        let card = OnThisDayCard(group(year: 2024, yearsAgo: 3, capturedDate: "2024-02-29", count: 2), apiBaseURL: baseURL, locale: usEnglish)
        XCTAssertEqual(card.dateText, "Feb 29, 2024")
    }

    func testDateIsFormattedAsACalendarDayInAnyLocale() {
        // Must not shift by the device zone: midnight UTC rendered as the same day.
        XCTAssertEqual(LibraryFilters.formatCapturedDate("2023-01-01", locale: usEnglish), "Jan 1, 2023")
        XCTAssertEqual(LibraryFilters.formatCapturedDate("2023-12-31", locale: usEnglish), "Dec 31, 2023")
        XCTAssertEqual(LibraryFilters.formatCapturedDate("not-a-date", locale: usEnglish), "not-a-date")
    }

    func testLargeCountsUseGroupedDigits() {
        XCTAssertEqual(OnThisDayCard.countText(0), "0 photos")
        XCTAssertEqual(OnThisDayCard.countText(1_234), "\(1_234.formatted()) photos")
    }
}

final class CapturedDateFilterTests: XCTestCase {
    func testCapturedDateIsActiveChipAndQuery() {
        let filters = LibraryFilters(minRating: 3, capturedDate: "2023-10-03")
        XCTAssertTrue(filters.isActive)
        XCTAssertTrue(LibraryFilters(capturedDate: "2023-10-03").isActive)
        XCTAssertEqual(filters.activeFields.map(\.field), [.minRating, .capturedDate])
        XCTAssertEqual(filters.activeFields.last?.title, LibraryFilters.formatCapturedDate("2023-10-03"))
        XCTAssertEqual(filters.photoQuery, PhotoQuery(minRating: 3, capturedDate: "2023-10-03"))
    }

    func testRemovingAndClearingDropCapturedDate() {
        let filters = LibraryFilters(tag: "dog", capturedDate: "2023-10-03")
        XCTAssertEqual(filters.removing(.capturedDate), LibraryFilters(tag: "dog"))
        var cleared = filters
        cleared.clear()
        XCTAssertNil(cleared.capturedDate)
        XCTAssertFalse(cleared.isActive)
    }

    func testSmartAlbumCriteriaExcludeCapturedDate() {
        let filters = LibraryFilters(mediaKind: .raw, tag: "dog", capturedDate: "2023-10-03")
        let criteria = SmartAlbumFilters(filters)
        XCTAssertEqual(criteria, SmartAlbumFilters(filterRaw: .raw, tag: "dog"))
        XCTAssertNil(criteria.photoQuery.capturedDate)
        let encoded = String(decoding: try! JSONEncoder().encode(criteria), as: UTF8.self)
        XCTAssertFalse(encoded.contains("capturedDate"))
    }

    func testSavableCriteriaDropViewScopes() {
        let bounds = PhotoBounds(north: 1, south: 0, east: 1, west: 0)
        let filters = LibraryFilters(flag: .pick, bounds: bounds, capturedDate: "2023-10-03")
        XCTAssertEqual(filters.savableCriteria, LibraryFilters(flag: .pick))
        XCTAssertFalse(LibraryFilters(capturedDate: "2023-10-03").savableCriteria.isActive)
    }

    func testCapturedDateOnlyFiltersAreNotSavableCriteria() {
        let criteria = SmartAlbumFilters(LibraryFilters(capturedDate: "2023-10-03"))
        XCTAssertTrue(criteria.isEmpty)
        XCTAssertThrowsError(try SmartAlbumDraft.validated(name: "Today", filters: criteria, query: nil)) { error in
            XCTAssertEqual(error as? SmartAlbumValidationError, .noCriteria)
        }
    }

    func testListingSourcesCarryCapturedDate() {
        let filters = LibraryFilters(capturedDate: "2023-10-03")
        XCTAssertEqual(PhotoListingSource(scope: .library, filters: filters), .photos(PhotoQuery(capturedDate: "2023-10-03")))
        var scoped = PhotoQuery(capturedDate: "2023-10-03")
        scoped.collectionId = 4
        XCTAssertEqual(PhotoListingSource(scope: .collection(4), filters: filters), .photos(scoped))
    }
}

@MainActor
final class OnThisDayStoreTests: XCTestCase {
    private let berlin = TimeZone(identifier: "Europe/Berlin")!
    private let years = [
        group(year: 2025, yearsAgo: 1, capturedDate: "2025-10-03", count: 4),
        group(year: 2021, yearsAgo: 5, capturedDate: "2021-10-03", count: 2),
    ]

    private func loadedStore(_ years: [OnThisDayYearDTO]? = nil) async -> OnThisDayStore {
        let api = TestAPI()
        await api.setOnThisDay(.success(OnThisDayResponseDTO(date: "2026-10-03", years: years ?? self.years)))
        let store = OnThisDayStore(api: api, timeZone: berlin, now: { utc("2026-10-03T10:00:00Z") })
        await store.load()
        return store
    }

    func testLoadPassesTheInjectedNowAndKeepsServerOrder() async {
        let api = TestAPI()
        await api.setOnThisDay(.success(OnThisDayResponseDTO(date: "2026-10-03", years: years)))
        let now = utc("2026-10-02T22:30:00Z")
        let store = OnThisDayStore(api: api, timeZone: berlin, now: { now })
        XCTAssertEqual(store.state, .idle)

        await store.load()

        XCTAssertEqual(store.state, .loaded(years))
        XCTAssertEqual(store.requestedDay, "2026-10-03", "Berlin local day, not the UTC day")
        let requests = await api.recordedOnThisDayRequests()
        XCTAssertEqual(requests, [now])
        XCTAssertEqual(store.cards(apiBaseURL: baseURL, locale: usEnglish).map(\.yearsAgoText), ["1 year ago", "5 years ago"])
    }

    func testVisibleOnlyOverTheUnfilteredWholeLibrary() async {
        let store = await loadedStore()
        XCTAssertTrue(store.isVisible(scope: .library, filters: LibraryFilters()))

        XCTAssertFalse(store.isVisible(scope: .library, filters: LibraryFilters(minRating: 2)))
        XCTAssertFalse(store.isVisible(scope: .library, filters: LibraryFilters(tag: "dog")))
        XCTAssertFalse(store.isVisible(scope: .library, filters: LibraryFilters(capturedDate: "2025-10-03")))
        XCTAssertFalse(store.isVisible(scope: .collection(3), filters: LibraryFilters()))
        XCTAssertFalse(store.isVisible(scope: .mapArea, filters: LibraryFilters()))
        XCTAssertFalse(store.isVisible(scope: .smartAlbum(filters: SmartAlbumFilters(tag: "dog"), query: nil), filters: LibraryFilters()))
    }

    func testHiddenWhenEmpty() async {
        let store = await loadedStore([])
        XCTAssertEqual(store.state, .loaded([]))
        XCTAssertFalse(store.isVisible(scope: .library, filters: LibraryFilters()))
    }

    func testHiddenBeforeLoadAndOnError() async {
        let api = TestAPI()
        await api.setOnThisDay(.failure(.transport("The network connection was lost.")))
        let store = OnThisDayStore(api: api, timeZone: berlin, now: { utc("2026-10-03T10:00:00Z") })
        XCTAssertFalse(store.isVisible(scope: .library, filters: LibraryFilters()))

        await store.load()

        XCTAssertEqual(store.state, .failed)
        XCTAssertTrue(store.years.isEmpty)
        XCTAssertFalse(store.isVisible(scope: .library, filters: LibraryFilters()))
    }

    func testErrorAfterContentHidesTheSection() async {
        let api = TestAPI()
        await api.setOnThisDay(.success(OnThisDayResponseDTO(date: "2026-10-03", years: years)))
        let store = OnThisDayStore(api: api, timeZone: berlin, now: { utc("2026-10-03T10:00:00Z") })
        await store.load()
        XCTAssertTrue(store.isVisible(scope: .library, filters: LibraryFilters()))

        await api.setOnThisDay(.failure(.transport("offline")))
        await store.load()
        XCTAssertFalse(store.isVisible(scope: .library, filters: LibraryFilters()))
    }

    func testBecomingActiveReloadsOnlyOnANewLocalDay() async {
        let api = TestAPI()
        await api.setOnThisDay(.success(OnThisDayResponseDTO(date: "2026-10-02", years: years)))
        // 23:50 in Berlin on Oct 2.
        let clock = TestClock(utc("2026-10-02T21:50:00Z"))
        let store = OnThisDayStore(api: api, timeZone: berlin, now: { clock.now })

        await store.applicationBecameActive()
        var requests = await api.recordedOnThisDayRequests()
        XCTAssertTrue(requests.isEmpty, "Never loaded: the Library's initial load owns the first request")

        await store.load()
        XCTAssertEqual(store.requestedDay, "2026-10-02")

        clock.set(utc("2026-10-02T21:59:59Z"))
        await store.applicationBecameActive()
        requests = await api.recordedOnThisDayRequests()
        XCTAssertEqual(requests.count, 1, "Same local day: no reload")

        let nextDay = [group(year: 2024, yearsAgo: 2, capturedDate: "2024-10-03", count: 8)]
        await api.setOnThisDay(.success(OnThisDayResponseDTO(date: "2026-10-03", years: nextDay)))
        clock.set(utc("2026-10-02T22:00:00Z"))
        await store.applicationBecameActive()

        requests = await api.recordedOnThisDayRequests()
        XCTAssertEqual(requests, [utc("2026-10-02T21:50:00Z"), utc("2026-10-02T22:00:00Z")])
        XCTAssertEqual(store.requestedDay, "2026-10-03")
        XCTAssertEqual(store.state, .loaded(nextDay))

        await store.applicationBecameActive()
        requests = await api.recordedOnThisDayRequests()
        XCTAssertEqual(requests.count, 2)
    }

    func testFailedLoadStillReloadsOnTheNextDay() async {
        let api = TestAPI()
        await api.setOnThisDay(.failure(.transport("offline")))
        let clock = TestClock(utc("2026-10-02T12:00:00Z"))
        let store = OnThisDayStore(api: api, timeZone: berlin, now: { clock.now })
        await store.load()
        XCTAssertEqual(store.state, .failed)

        await api.setOnThisDay(.success(OnThisDayResponseDTO(date: "2026-10-03", years: years)))
        clock.set(utc("2026-10-03T12:00:00Z"))
        await store.applicationBecameActive()
        XCTAssertEqual(store.state, .loaded(years))
    }
}

@MainActor
final class OnThisDayLibraryTests: XCTestCase {
    private func loadedLibrary(api: TestAPI) async -> LibraryStore {
        let photos = [TestModels.photo(id: 1), TestModels.photo(id: 2)]
        await api.setPhotos(PhotosResponseDTO(photos: photos, total: photos.count, rawCount: 0))
        let store = LibraryStore(api: api)
        await store.load()
        return store
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

    func testTappingACardAppliesCapturedDateAndTheChipClearsIt() async throws {
        let api = TestAPI()
        let store = await loadedLibrary(api: api)
        let card = OnThisDayCard(
            group(year: 2023, yearsAgo: 3, capturedDate: "2023-10-03", count: 2),
            apiBaseURL: api.baseURL,
            locale: usEnglish
        )

        store.showCapturedDate(card.capturedDate)

        XCTAssertEqual(store.filters, LibraryFilters(capturedDate: "2023-10-03"))
        XCTAssertEqual(store.filters.activeFields.map(\.field), [.capturedDate])
        XCTAssertEqual(store.filters.summary, LibraryFilters.formatCapturedDate("2023-10-03"))
        try await waitForLastQuery(PhotoQuery(capturedDate: "2023-10-03"), api: api)

        store.applyFilters(store.filters.removing(.capturedDate))
        XCTAssertFalse(store.filters.isActive)
        try await waitForLastQuery(PhotoQuery(), api: api)
    }

    func testClearAllRemovesCapturedDate() async throws {
        let api = TestAPI()
        let store = await loadedLibrary(api: api)
        store.showCapturedDate("2021-10-03")
        try await waitForLastQuery(PhotoQuery(capturedDate: "2021-10-03"), api: api)

        store.clearFilters()

        XCTAssertNil(store.filters.capturedDate)
        try await waitForLastQuery(PhotoQuery(), api: api)
    }

    func testCapturedDateFilterHidesTheSection() async throws {
        let api = TestAPI()
        await api.setOnThisDay(.success(OnThisDayResponseDTO(
            date: "2026-10-03",
            years: [group(year: 2025, yearsAgo: 1, capturedDate: "2025-10-03", count: 3)]
        )))
        let library = await loadedLibrary(api: api)
        let onThisDay = OnThisDayStore(api: api, now: { utc("2026-10-03T10:00:00Z") })
        await onThisDay.load()
        XCTAssertTrue(onThisDay.isVisible(scope: library.scope, filters: library.filters))

        library.showCapturedDate("2025-10-03")
        XCTAssertFalse(onThisDay.isVisible(scope: library.scope, filters: library.filters))

        library.clearFilters()
        XCTAssertTrue(onThisDay.isVisible(scope: library.scope, filters: library.filters))
    }
}
