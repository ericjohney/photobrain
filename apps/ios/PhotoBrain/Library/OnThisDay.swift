import Foundation

/// Calendar-day strings for On this day. The request date is the device's local calendar day;
/// capture dates are EXIF wall-clock days, so both are plain `yyyy-MM-dd` values with no
/// time-zone conversion.
enum OnThisDayDate {
    /// Gregorian UTC calendar for treating a `yyyy-MM-dd` value as a timeless day.
    static let utcCalendar: Calendar = {
        var calendar = Calendar(identifier: .gregorian)
        calendar.locale = Locale(identifier: "en_US_POSIX")
        calendar.timeZone = TimeZone(secondsFromGMT: 0)!
        return calendar
    }()

    /// `date`'s calendar day in `timeZone` as `yyyy-MM-dd`, always Gregorian with ASCII digits
    /// whatever the user's calendar or locale. The default follows the device's current zone.
    static func localDayString(_ date: Date, timeZone: TimeZone? = nil) -> String {
        guard let timeZone else { return currentDayFormatter.string(from: date) }
        return makeDayFormatter(timeZone: timeZone).string(from: date)
    }

    /// `autoupdatingCurrent` tracks device time-zone changes, so one instance suffices.
    private static let currentDayFormatter = makeDayFormatter(timeZone: .autoupdatingCurrent)

    private static func makeDayFormatter(timeZone: TimeZone) -> DateFormatter {
        let formatter = DateFormatter()
        formatter.calendar = Calendar(identifier: .gregorian)
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.timeZone = timeZone
        formatter.dateFormat = "yyyy-MM-dd"
        return formatter
    }

    /// Midnight UTC of a strict `yyyy-MM-dd` real calendar date; `nil` for anything else
    /// (wrong shape, `2023-02-29`, `2024-13-01`).
    static func date(from value: String) -> Date? {
        let bytes = Array(value.utf8)
        guard bytes.count == 10, bytes[4] == UInt8(ascii: "-"), bytes[7] == UInt8(ascii: "-") else { return nil }
        for index in [0, 1, 2, 3, 5, 6, 8, 9] where !(UInt8(ascii: "0")...UInt8(ascii: "9")).contains(bytes[index]) {
            return nil
        }
        func number(_ range: Range<Int>) -> Int {
            bytes[range].reduce(0) { $0 * 10 + Int($1 - UInt8(ascii: "0")) }
        }
        let components = DateComponents(year: number(0..<4), month: number(5..<7), day: number(8..<10))
        guard let date = utcCalendar.date(from: components) else { return nil }
        let resolved = utcCalendar.dateComponents([.year, .month, .day], from: date)
        guard resolved.year == components.year, resolved.month == components.month, resolved.day == components.day else {
            return nil
        }
        return date
    }
}

/// Display text for one On this day card.
struct OnThisDayCard: Identifiable, Equatable, Sendable {
    let year: Int
    /// `1 year ago`, `3 years ago`.
    let yearsAgoText: String
    /// The matched capture date, e.g. `Oct 3, 2023`.
    let dateText: String
    /// `1 photo`, `12 photos`.
    let countText: String
    /// Applied as the Library's `capturedDate` filter when the card is tapped.
    let capturedDate: String
    let coverPhotoID: Int
    let coverURL: URL

    var id: Int { year }

    var accessibilityLabel: String { "\(yearsAgoText), \(dateText), \(countText)" }

    init(_ group: OnThisDayYearDTO, apiBaseURL: URL, locale: Locale = .autoupdatingCurrent) {
        year = group.year
        yearsAgoText = Self.yearsAgoText(group.yearsAgo)
        dateText = LibraryFilters.formatCapturedDate(group.capturedDate, locale: locale)
        countText = Self.countText(group.count)
        capturedDate = group.capturedDate
        coverPhotoID = group.cover.photoId
        coverURL = group.coverURL(apiBaseURL: apiBaseURL)
    }

    static func yearsAgoText(_ yearsAgo: Int) -> String {
        yearsAgo == 1 ? "1 year ago" : "\(yearsAgo) years ago"
    }

    static func countText(_ count: Int) -> String {
        count == 1 ? "1 photo" : "\(count.formatted()) photos"
    }
}

/// Loads the Library's On this day cards for the device's local calendar day and reloads when
/// the app becomes active on a later day.
@MainActor
final class OnThisDayStore: ObservableObject {
    enum State: Equatable {
        case idle
        case loading
        case loaded([OnThisDayYearDTO])
        /// Load errors hide the section; there is no inline error UI.
        case failed
    }

    @Published private(set) var state: State = .idle
    /// Local day of the most recent request.
    private(set) var requestedDay: String?

    let api: any PhotoBrainAPI
    private let now: @Sendable () -> Date
    /// Zone deciding the local day; `nil` follows the device, matching `APIClient.onThisDay`.
    private let timeZone: TimeZone?
    private var generation = 0

    init(
        api: any PhotoBrainAPI,
        timeZone: TimeZone? = nil,
        now: @escaping @Sendable () -> Date = { Date() }
    ) {
        self.api = api
        self.timeZone = timeZone
        self.now = now
    }

    var years: [OnThisDayYearDTO] {
        guard case let .loaded(years) = state else { return [] }
        return years
    }

    /// Shown only over the whole, unfiltered library, and only when there is something to show
    /// (never while loading or after an error).
    func isVisible(scope: LibraryScope, filters: LibraryFilters) -> Bool {
        scope == .library && !filters.isActive && !years.isEmpty
    }

    func cards(apiBaseURL: URL, locale: Locale = .autoupdatingCurrent) -> [OnThisDayCard] {
        years.map { OnThisDayCard($0, apiBaseURL: apiBaseURL, locale: locale) }
    }

    /// Requests today's cards. A refresh on the same day keeps the current cards until the
    /// response arrives; a new day hides them first so stale years never show.
    func load() async {
        generation += 1
        let requestGeneration = generation
        let date = now()
        let day = OnThisDayDate.localDayString(date, timeZone: timeZone)
        if day != requestedDay || years.isEmpty { state = .loading }
        requestedDay = day
        do {
            let response = try await api.onThisDay(date: date)
            guard requestGeneration == generation else { return }
            state = .loaded(response.years)
        } catch is CancellationError {
            return
        } catch {
            guard requestGeneration == generation else { return }
            state = .failed
        }
    }

    /// Reloads when the local day has changed since the last request.
    func applicationBecameActive() async {
        guard let requestedDay,
              requestedDay != OnThisDayDate.localDayString(now(), timeZone: timeZone) else { return }
        await load()
    }
}
