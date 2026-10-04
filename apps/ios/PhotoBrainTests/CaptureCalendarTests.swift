import XCTest
@testable import PhotoBrain

private let baseURL = URL(string: "https://photos.example.invalid")!
private let usEnglish = Locale(identifier: "en_US")

private func photoRecord(id: Int, taken: String?) -> PhotoRecord {
    PhotoRecord(dto: TestModels.photo(id: id, taken: taken), apiBaseURL: baseURL)
}

private func month(_ year: Int, _ month: Int) -> CaptureCalendar.Month {
    CaptureCalendar.Month(year: year, month: month)
}

private func day(_ year: Int, _ month: Int, _ day: Int) -> CaptureCalendar.Day {
    CaptureCalendar.Day(year: year, month: month, day: day)
}

final class CaptureCalendarDayKeyTests: XCTestCase {
    func testEXIFTimestampUsesItsOwnDay() {
        XCTAssertEqual(CaptureCalendar.dayKey("2023:10:03 23:30:00"), "2023-10-03")
        XCTAssertEqual(CaptureCalendar.dayKey("2023:10:03"), "2023-10-03")
    }

    func testISOWithOffsetKeepsTheWallClockDay() {
        // 23:30 at -07:00 is 06:30 UTC on Oct 4; the wall-clock day must stay Oct 3.
        XCTAssertEqual(CaptureCalendar.dayKey("2023-10-03T23:30:00-07:00"), "2023-10-03")
        XCTAssertEqual(CaptureCalendar.dayKey("2023-10-04T00:30:00+09:00"), "2023-10-04")
        XCTAssertEqual(CaptureCalendar.dayKey("2024-02-29T12:00:00.123Z"), "2024-02-29")
    }

    func testMissingOrMalformedValuesHaveNoDay() {
        for value in [nil, "", "2023:10", "2023/10/03 10:00:00", "0000:00:00 00:00:00", "2023:13:01 00:00:00",
                      "2023-02-29", "2023-04-31", "20231003", "abcd:ef:gh 00:00:00", "２０２３:10:03"] {
            XCTAssertNil(CaptureCalendar.dayKey(value), String(describing: value))
        }
    }

    func testDayParsesCapturedDateFilterValues() {
        XCTAssertEqual(CaptureCalendar.Day(raw: "2023-10-03"), day(2023, 10, 3))
        XCTAssertEqual(day(2023, 1, 9).capturedDate, "2023-01-09")
    }
}

final class CaptureCalendarCountTests: XCTestCase {
    func testCountsOnlyPhotosWithAnEXIFCaptureDay() {
        let fixtureOnly = PhotoRecord(
            id: 90,
            filename: "fixture.jpg",
            thumbnailURL: baseURL,
            isConvertedRAW: false,
            exifDate: Date(timeIntervalSince1970: 1_696_300_000),
            modifiedDate: Date(timeIntervalSince1970: 1_696_300_000),
            createdDate: nil,
            pixelWidth: 1,
            pixelHeight: 1,
            cameraModel: nil,
            lensModel: nil
        )
        let records = [
            photoRecord(id: 1, taken: "2023:10:03 08:00:00"),
            photoRecord(id: 2, taken: "2023-10-03T23:30:00-07:00"),
            photoRecord(id: 3, taken: "2023:10:04 01:00:00"),
            photoRecord(id: 4, taken: nil),
            photoRecord(id: 5, taken: "garbage"),
            photoRecord(id: 6, taken: "2023:11:01 09:00:00"),
            fixtureOnly,
        ]

        let calendar = CaptureCalendar(records: records)

        XCTAssertEqual(calendar.photoCount, 4)
        XCTAssertEqual(calendar.count(on: day(2023, 10, 3)), 2)
        XCTAssertEqual(calendar.count(on: day(2023, 10, 4)), 1)
        XCTAssertEqual(calendar.count(on: day(2023, 10, 5)), 0)
        XCTAssertEqual(calendar.months, [month(2023, 10), month(2023, 11)])
        XCTAssertEqual(calendar.capturedDate(selecting: day(2023, 10, 3)), "2023-10-03")
        XCTAssertNil(calendar.capturedDate(selecting: day(2023, 10, 5)))
    }

    func testEmptyCalendarHasNoMonths() {
        let calendar = CaptureCalendar(records: [photoRecord(id: 1, taken: nil)])
        XCTAssertEqual(calendar.months, [])
        XCTAssertNil(calendar.initialMonth(capturedDate: nil))
    }
}

final class CaptureCalendarGridTests: XCTestCase {
    private func leadingBlanks(_ cells: [CaptureCalendar.Cell]) -> Int {
        cells.prefix { if case .blank = $0 { true } else { false } }.count
    }

    func testOctober2023StartsOnSunday() {
        let calendar = CaptureCalendar(records: [photoRecord(id: 1, taken: "2023:10:03 12:00:00")])
        let sundayFirst = calendar.cells(for: month(2023, 10), firstWeekday: 1)
        let mondayFirst = calendar.cells(for: month(2023, 10), firstWeekday: 2)

        XCTAssertEqual(leadingBlanks(sundayFirst), 0)
        XCTAssertEqual(leadingBlanks(mondayFirst), 6)
        XCTAssertEqual(sundayFirst.count, 31)
        XCTAssertEqual(mondayFirst.count, 37)
        XCTAssertEqual(mondayFirst[6 + 2], .day(day(2023, 10, 3), count: 1))
        XCTAssertEqual(mondayFirst[6 + 3], .day(day(2023, 10, 4), count: 0))
        XCTAssertEqual(Set(mondayFirst.map(\.id)).count, mondayFirst.count)
    }

    func testLeadingBlanksMatchFoundationCalendar() {
        var gregorian = Calendar(identifier: .gregorian)
        gregorian.timeZone = TimeZone(secondsFromGMT: 0)!
        for year in [1900, 2000, 2023, 2024, 2100] {
            for monthNumber in 1...12 {
                let first = gregorian.date(from: DateComponents(year: year, month: monthNumber, day: 1))!
                let weekday = gregorian.component(.weekday, from: first)
                XCTAssertEqual(CaptureCalendar.weekday(year: year, month: monthNumber, day: 1), weekday, "\(year)-\(monthNumber)")
                XCTAssertEqual(
                    gregorian.range(of: .day, in: .month, for: first)!.count,
                    CaptureCalendar.daysIn(year: year, month: monthNumber)
                )
                for firstWeekday in [1, 2] {
                    XCTAssertEqual(
                        CaptureCalendar.leadingBlanks(for: month(year, monthNumber), firstWeekday: firstWeekday),
                        (weekday - firstWeekday + 7) % 7
                    )
                }
            }
        }
        // February 2024 starts on Thursday: 4 blanks Sunday-first, 3 Monday-first.
        XCTAssertEqual(CaptureCalendar.leadingBlanks(for: month(2024, 2), firstWeekday: 1), 4)
        XCTAssertEqual(CaptureCalendar.leadingBlanks(for: month(2024, 2), firstWeekday: 2), 3)
    }

    func testWeekdaySymbolsRotateToFirstWeekday() {
        let symbols = ["S", "M", "T", "W", "T2", "F", "S2"]
        XCTAssertEqual(CaptureCalendar.orderedWeekdaySymbols(symbols, firstWeekday: 1), symbols)
        XCTAssertEqual(CaptureCalendar.orderedWeekdaySymbols(symbols, firstWeekday: 2), ["M", "T", "W", "T2", "F", "S2", "S"])
    }

    func testTitleAndAccessibilityLabelUseTheTimelessDay() {
        XCTAssertEqual(CaptureCalendar.title(for: month(2023, 10), locale: usEnglish), "October 2023")
        XCTAssertEqual(
            CaptureCalendar.accessibilityLabel(for: day(2023, 10, 3), count: 12, locale: usEnglish),
            "October 3, 2023, 12 photos"
        )
        XCTAssertEqual(
            CaptureCalendar.accessibilityLabel(for: day(2023, 10, 1), count: 1, locale: usEnglish),
            "October 1, 2023, 1 photo"
        )
        XCTAssertEqual(
            CaptureCalendar.accessibilityLabel(for: day(2023, 10, 31), count: 0, locale: usEnglish),
            "October 31, 2023, no photos"
        )
    }
}

final class CaptureCalendarNavigationTests: XCTestCase {
    private let calendar = CaptureCalendar(records: [
        photoRecord(id: 1, taken: "2021:12:25 10:00:00"),
        photoRecord(id: 2, taken: "2023:03:01 10:00:00"),
        photoRecord(id: 3, taken: "2023:10:03 10:00:00"),
        photoRecord(id: 4, taken: "2023:10:20 10:00:00"),
    ])

    func testNavigationSkipsEmptyMonthsAndStopsAtEnds() {
        XCTAssertEqual(calendar.months, [month(2021, 12), month(2023, 3), month(2023, 10)])
        XCTAssertEqual(calendar.previousMonth(before: month(2023, 10)), month(2023, 3))
        XCTAssertEqual(calendar.previousMonth(before: month(2023, 3)), month(2021, 12))
        XCTAssertNil(calendar.previousMonth(before: month(2021, 12)))
        XCTAssertEqual(calendar.nextMonth(after: month(2021, 12)), month(2023, 3))
        XCTAssertEqual(calendar.nextMonth(after: month(2023, 3)), month(2023, 10))
        XCTAssertNil(calendar.nextMonth(after: month(2023, 10)))
    }

    func testNavigationFromAnEmptyMonthFindsTheNearestNeighbours() {
        XCTAssertEqual(calendar.previousMonth(before: month(2022, 6)), month(2021, 12))
        XCTAssertEqual(calendar.nextMonth(after: month(2022, 6)), month(2023, 3))
        XCTAssertNil(calendar.previousMonth(before: month(2020, 1)))
        XCTAssertNil(calendar.nextMonth(after: month(2024, 1)))
    }

    func testInitialMonthIsNewestOrTheActiveCapturedDate() {
        XCTAssertEqual(calendar.initialMonth(capturedDate: nil), month(2023, 10))
        XCTAssertEqual(calendar.initialMonth(capturedDate: "2021-12-25"), month(2021, 12))
        XCTAssertEqual(calendar.initialMonth(capturedDate: "2022-06-15"), month(2022, 6))
        XCTAssertEqual(calendar.initialMonth(capturedDate: "not-a-date"), month(2023, 10))
    }

    func testBuildingTenThousandRecordsStaysUnderThirtyMilliseconds() {
        let records = (0..<10_000).map { index -> PhotoRecord in
            let taken: String? = index % 10 == 0
                ? nil
                : String(format: "%04d:%02d:%02d %02d:00:00", 2015 + index % 10, 1 + index % 12, 1 + index % 28, index % 24)
            return photoRecord(id: index, taken: taken)
        }
        let clock = ContinuousClock()
        var durations: [Duration] = []
        var built: CaptureCalendar?
        for _ in 0..<5 {
            durations.append(clock.measure { built = CaptureCalendar(records: records) })
        }
        let median = durations.sorted()[durations.count / 2]
        let milliseconds = Double(median.components.attoseconds) / 1e15 + Double(median.components.seconds) * 1_000
        print("CaptureCalendar(records: 10,000) median \(String(format: "%.2f", milliseconds)) ms over 5 runs")
        XCTAssertEqual(built?.photoCount, 9_000)
        XCTAssertLessThan(milliseconds, 30)
    }
}

@MainActor
final class CaptureCalendarLibraryTests: XCTestCase {
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

    func testStoreCalendarCountsLoadedRecordsAndRebuildsOnReload() async {
        let api = TestAPI()
        await api.setPhotos(PhotosResponseDTO(
            photos: [
                TestModels.photo(id: 1, taken: "2023:10:03 09:00:00"),
                TestModels.photo(id: 2, taken: "2023:10:03 18:00:00"),
                TestModels.photo(id: 3, taken: nil),
            ],
            total: 3,
            rawCount: 0
        ))
        let store = LibraryStore(api: api)
        await store.load()

        XCTAssertEqual(store.captureCalendar.count(on: day(2023, 10, 3)), 2)
        XCTAssertEqual(store.captureCalendar.months, [month(2023, 10)])

        await api.setPhotos(PhotosResponseDTO(photos: [TestModels.photo(id: 4, taken: "2024:01:05 09:00:00")], total: 1, rawCount: 0))
        await store.load()

        XCTAssertEqual(store.captureCalendar.months, [month(2024, 1)])
        XCTAssertEqual(store.captureCalendar.count(on: day(2023, 10, 3)), 0)
    }

    func testTappingADayAppliesCapturedDateThroughTheLibraryFilter() async throws {
        let api = TestAPI()
        await api.setPhotos(PhotosResponseDTO(
            photos: [TestModels.photo(id: 1, taken: "2023-10-03T23:30:00-07:00")],
            total: 1,
            rawCount: 0
        ))
        let store = LibraryStore(api: api, filters: LibraryFilters(minRating: 2))
        await store.load()
        let calendar = store.captureCalendar
        var selected: [String] = []
        let select: (String) -> Void = { value in
            selected.append(value)
            store.showCapturedDate(value)
        }

        if let value = calendar.capturedDate(selecting: day(2023, 10, 4)) { select(value) }
        XCTAssertEqual(selected, [])
        if let value = calendar.capturedDate(selecting: day(2023, 10, 3)) { select(value) }

        XCTAssertEqual(selected, ["2023-10-03"])
        XCTAssertEqual(store.filters, LibraryFilters(minRating: 2, capturedDate: "2023-10-03"))
        XCTAssertEqual(store.filters.activeFields.map(\.field), [.minRating, .capturedDate])
        try await waitForLastQuery(PhotoQuery(minRating: 2, capturedDate: "2023-10-03"), api: api)
        XCTAssertEqual(store.captureCalendar.initialMonth(capturedDate: store.filters.capturedDate), month(2023, 10))
    }
}
