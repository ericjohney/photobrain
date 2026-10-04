import Foundation

/// Per-day EXIF capture counts over the Library's loaded (already filtered) records, for the
/// Calendar sheet. Days come straight from the raw EXIF `dateTaken` text: its first ten
/// characters with `:` read as `-`, exactly like the server's `capturedDate` filter. Capture
/// dates are wall-clock values, so no time zone is ever applied, and photos without an EXIF
/// date are not counted (the `capturedDate` filter could never match them).
struct CaptureCalendar: Sendable {
    struct Month: Hashable, Comparable, Sendable {
        let year: Int
        let month: Int

        static func < (lhs: Self, rhs: Self) -> Bool {
            (lhs.year, lhs.month) < (rhs.year, rhs.month)
        }

        fileprivate var packed: Int { year * 100 + month }
    }

    struct Day: Hashable, Sendable {
        let year: Int
        let month: Int
        let day: Int

        var calendarMonth: Month { Month(year: year, month: month) }

        /// The `capturedDate` filter value, `yyyy-MM-dd`.
        var capturedDate: String {
            String(format: "%04d-%02d-%02d", year, month, day)
        }

        fileprivate var packed: Int { (year * 100 + month) * 100 + day }

        init(year: Int, month: Int, day: Int) {
            self.year = year
            self.month = month
            self.day = day
        }

        /// The day of an EXIF `dateTaken` value (`2023:10:03 23:30:00`, `2023-10-03T23:30:00-07:00`)
        /// or a `capturedDate` filter value (`2023-10-03`). Requires `yyyy?MM?dd` with `:` or `-`
        /// separators at the start and a real proleptic Gregorian date from year 1; anything else
        /// (missing, `0000:00:00 00:00:00`, `2023-02-29`) is `nil`.
        init?(raw: String?) {
            guard var value = raw else { return nil }
            let parsed: (Int, Int, Int)? = value.withUTF8 { bytes in
                guard bytes.count >= 10 else { return nil }
                func separator(_ index: Int) -> Bool {
                    bytes[index] == UInt8(ascii: ":") || bytes[index] == UInt8(ascii: "-")
                }
                guard separator(4), separator(7) else { return nil }
                func number(_ range: Range<Int>) -> Int? {
                    var result = 0
                    for index in range {
                        let digit = Int(bytes[index]) &- 48
                        guard digit >= 0, digit <= 9 else { return nil }
                        result = result * 10 + digit
                    }
                    return result
                }
                guard let year = number(0..<4), let month = number(5..<7), let day = number(8..<10) else { return nil }
                return (year, month, day)
            }
            guard let (year, month, day) = parsed,
                  year >= 1,
                  (1...12).contains(month),
                  day >= 1,
                  day <= CaptureCalendar.daysIn(year: year, month: month) else { return nil }
            self.year = year
            self.month = month
            self.day = day
        }
    }

    /// One slot of a month grid: a leading blank before the first weekday, or a day.
    enum Cell: Identifiable, Hashable, Sendable {
        case blank(Int)
        case day(Day, count: Int)

        var id: Int {
            switch self {
            case let .blank(index): -1 - index
            case let .day(day, _): day.packed
            }
        }
    }

    /// Ascending months that contain at least one counted photo.
    let months: [Month]
    /// Photos with a usable EXIF capture day.
    let photoCount: Int
    private let counts: [Int: Int]

    init(records: [PhotoRecord]) {
        var counts: [Int: Int] = [:]
        var monthKeys = Set<Int>()
        var photoCount = 0
        for record in records {
            guard let day = Day(raw: record.exif?.dateTaken) else { continue }
            counts[day.packed, default: 0] += 1
            monthKeys.insert(day.calendarMonth.packed)
            photoCount += 1
        }
        self.counts = counts
        self.photoCount = photoCount
        months = monthKeys.sorted().map { Month(year: $0 / 100, month: $0 % 100) }
    }

    /// The `yyyy-MM-dd` capture day of a raw EXIF `dateTaken`, or `nil` when unusable.
    static func dayKey(_ dateTaken: String?) -> String? {
        Day(raw: dateTaken)?.capturedDate
    }

    func count(on day: Day) -> Int {
        counts[day.packed] ?? 0
    }

    /// The `capturedDate` filter a tap on `day` applies; `nil` for a day without photos.
    func capturedDate(selecting day: Day) -> String? {
        count(on: day) > 0 ? day.capturedDate : nil
    }

    /// The active `capturedDate` filter's month when set and valid, else the newest month with
    /// photos; `nil` when there is nothing to show.
    func initialMonth(capturedDate: String?) -> Month? {
        Day(raw: capturedDate)?.calendarMonth ?? months.last
    }

    /// The nearest earlier month with photos; `nil` at the oldest.
    func previousMonth(before month: Month) -> Month? {
        let index = insertionIndex(of: month)
        return index > 0 ? months[index - 1] : nil
    }

    /// The nearest later month with photos; `nil` at the newest.
    func nextMonth(after month: Month) -> Month? {
        var index = insertionIndex(of: month)
        if index < months.count, months[index] == month { index += 1 }
        return index < months.count ? months[index] : nil
    }

    /// Leading blanks so day 1 falls under its weekday column, then every day with its count.
    /// `firstWeekday` follows `Calendar.firstWeekday` (1 = Sunday, 2 = Monday).
    func cells(for month: Month, firstWeekday: Int) -> [Cell] {
        let blanks = Self.leadingBlanks(for: month, firstWeekday: firstWeekday)
        let dayCount = Self.daysIn(year: month.year, month: month.month)
        var cells: [Cell] = []
        cells.reserveCapacity(blanks + dayCount)
        for index in 0..<blanks { cells.append(.blank(index)) }
        for number in 1...dayCount {
            let day = Day(year: month.year, month: month.month, day: number)
            cells.append(.day(day, count: count(on: day)))
        }
        return cells
    }

    static func leadingBlanks(for month: Month, firstWeekday: Int) -> Int {
        ((weekday(year: month.year, month: month.month, day: 1) - firstWeekday) % 7 + 7) % 7
    }

    /// Gregorian weekday numbered like `Calendar` (1 = Sunday … 7 = Saturday).
    static func weekday(year: Int, month: Int, day: Int) -> Int {
        let offsets = [0, 3, 2, 5, 0, 3, 5, 1, 4, 6, 2, 4]
        let y = month < 3 ? year - 1 : year
        return (y + y / 4 - y / 100 + y / 400 + offsets[month - 1] + day) % 7 + 1
    }

    static func daysIn(year: Int, month: Int) -> Int {
        switch month {
        case 2: (year % 4 == 0 && year % 100 != 0) || year % 400 == 0 ? 29 : 28
        case 4, 6, 9, 11: 30
        default: 31
        }
    }

    /// `symbols` (Sunday first, as `Calendar` returns them) rotated to start at `firstWeekday`.
    static func orderedWeekdaySymbols(_ symbols: [String], firstWeekday: Int) -> [String] {
        guard symbols.count == 7 else { return symbols }
        let start = ((firstWeekday - 1) % 7 + 7) % 7
        return Array(symbols[start...] + symbols[..<start])
    }

    /// `October 2023` in `locale`.
    static func title(for month: Month, locale: Locale = .autoupdatingCurrent) -> String {
        guard let date = OnThisDayDate.utcCalendar.date(from: DateComponents(year: month.year, month: month.month, day: 1)) else {
            return "\(month.year)-\(month.month)"
        }
        return date.formatted(dayFormat(locale: locale).year().month(.wide))
    }

    /// `October 3, 2023, 12 photos` in `locale`; zero days read `no photos`.
    static func accessibilityLabel(for day: Day, count: Int, locale: Locale = .autoupdatingCurrent) -> String {
        let countText = count == 0 ? "no photos" : CountText.photos(count)
        guard let date = OnThisDayDate.utcCalendar.date(from: DateComponents(year: day.year, month: day.month, day: day.day)) else {
            return "\(day.capturedDate), \(countText)"
        }
        return "\(date.formatted(dayFormat(locale: locale).year().month(.wide).day())), \(countText)"
    }

    /// Formats timeless UTC-midnight days without shifting them into the device zone.
    private static func dayFormat(locale: Locale) -> Date.FormatStyle {
        Date.FormatStyle(locale: locale, calendar: OnThisDayDate.utcCalendar, timeZone: OnThisDayDate.utcCalendar.timeZone)
    }

    /// First index whose month is not earlier than `month`.
    private func insertionIndex(of month: Month) -> Int {
        var low = 0
        var high = months.count
        while low < high {
            let mid = (low + high) / 2
            if months[mid] < month { low = mid + 1 } else { high = mid }
        }
        return low
    }
}
