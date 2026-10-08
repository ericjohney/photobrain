import Foundation

/// The `event` filter: an auto event's id plus the title its chip shows.
struct EventFilter: Hashable, Sendable {
    let id: Int
    let title: String
}

/// Display text for auto events, shared with the web client's rules. `startAt`/`endAt` are EXIF
/// wall-clock times, so their days are read from the text and formatted in a fixed GMT
/// calendar: the device time zone never shifts a day.
enum EventFormatting {
    /// `Kyoto, Japan` for a city, `Japan` for a country-only place, and a single name when the
    /// city and country are the same (`Singapore`).
    static func placeLabel(_ place: EventPlaceDTO) -> String {
        guard let city = place.city, !city.isEmpty, city != place.country else { return place.country }
        return "\(city), \(place.country)"
    }

    /// `Oct 3, 2023`, `Oct 3 – 5, 2023`, `Sep 30 – Oct 2, 2023`, or `Dec 30, 2023 – Jan 2, 2024`
    /// in `locale`. ICU's thin spaces around the range dash become plain spaces, matching web.
    /// Unparseable values are shown as sent.
    static func dateRange(startAt: String, endAt: String, locale: Locale = .autoupdatingCurrent) -> String {
        guard let start = day(startAt), let end = day(endAt) else {
            return startAt == endAt ? startAt : "\(startAt) – \(endAt)"
        }
        let calendar = OnThisDayDate.utcCalendar
        if start == end {
            return start.formatted(Date.FormatStyle(
                date: .abbreviated,
                time: .omitted,
                locale: locale,
                calendar: calendar,
                timeZone: calendar.timeZone
            ))
        }
        let range = (min(start, end)..<max(start, end)).formatted(Date.IntervalFormatStyle(
            date: .abbreviated,
            time: .omitted,
            locale: locale,
            calendar: calendar,
            timeZone: calendar.timeZone
        ))
        return range.replacingOccurrences(of: "\u{2009}", with: " ")
    }

    /// The place label when the event has a place, else its date range.
    static func title(for event: EventDTO, locale: Locale = .autoupdatingCurrent) -> String {
        event.place.map(placeLabel) ?? dateRange(startAt: event.startAt, endAt: event.endAt, locale: locale)
    }

    /// `Oct 3 – 5, 2023 · 12 photos` under a place title; only `12 photos` when the title is
    /// already the date range.
    static func subtitle(for event: EventDTO, locale: Locale = .autoupdatingCurrent) -> String {
        let count = CountText.photos(event.photoCount)
        guard event.place != nil else { return count }
        return "\(dateRange(startAt: event.startAt, endAt: event.endAt, locale: locale)) · \(count)"
    }

    /// Midnight GMT of a wall-clock `YYYY-MM-DDTHH:MM:SS` (or bare `YYYY-MM-DD`) value's day;
    /// `nil` for anything else.
    static func day(_ value: String) -> Date? {
        let utf8 = value.utf8
        guard utf8.count == 10 || utf8.dropFirst(10).first == UInt8(ascii: "T") else { return nil }
        return OnThisDayDate.date(from: String(value.prefix(10)))
    }
}

/// Display text and filter for one Events card.
struct EventCard: Identifiable, Hashable, Sendable {
    let id: Int
    let title: String
    let subtitle: String
    let coverPhotoID: Int
    let coverURL: URL

    /// Applied as the `event` filter when the card is opened; the chip shows `title`.
    var filter: EventFilter { EventFilter(id: id, title: title) }

    var accessibilityLabel: String { "\(title), \(subtitle)" }

    init(_ event: EventDTO, apiBaseURL: URL, locale: Locale = .autoupdatingCurrent) {
        id = event.id
        title = EventFormatting.title(for: event, locale: locale)
        subtitle = EventFormatting.subtitle(for: event, locale: locale)
        coverPhotoID = event.cover.photoId
        coverURL = event.coverURL(apiBaseURL: apiBaseURL)
    }
}

/// Loads the Collections tab's auto events (whole library, newest first). A failure before
/// any successful load becomes `.failed`; later failures keep the current list and surface
/// `errorMessage`.
@MainActor
final class EventsStore: ObservableObject {
    enum LoadState: Equatable {
        case idle
        case loading
        case loaded
        case failed(String)
    }

    @Published private(set) var events: [EventDTO] = []
    @Published private(set) var loadState: LoadState = .idle
    @Published private(set) var errorMessage: String?

    let api: any PhotoBrainAPI
    private var loadTask: Task<Void, Never>?
    /// Bumped by every load; older responses are discarded.
    private var generation = 0

    init(api: any PhotoBrainAPI) {
        self.api = api
    }

    func cards(apiBaseURL: URL, locale: Locale = .autoupdatingCurrent) -> [EventCard] {
        events.map { EventCard($0, apiBaseURL: apiBaseURL, locale: locale) }
    }

    func dismissError() {
        errorMessage = nil
    }

    func load() async {
        generation += 1
        let requestGeneration = generation
        loadTask?.cancel()
        if loadState != .loaded { loadState = .loading }
        let task = Task { [api] in
            do {
                let response = try await api.events(folder: nil)
                guard !Task.isCancelled, requestGeneration == generation else { return }
                events = response.events
                loadState = .loaded
                errorMessage = nil
            } catch is CancellationError {
                return
            } catch {
                guard requestGeneration == generation else { return }
                let message = CollectionsStore.message(for: error)
                if loadState == .loaded {
                    errorMessage = message
                } else {
                    loadState = .failed(message)
                }
            }
        }
        loadTask = task
        await task.value
    }

    func loadIfNeeded() async {
        switch loadState {
        case .idle, .failed: await load()
        case .loading: await loadTask?.value
        case .loaded: return
        }
    }
}

extension LibraryStore {
    /// One event's members with the shared grid and loupe; no filter UI or filter options.
    static func event(_ filter: EventFilter, api: any PhotoBrainAPI, curation: PhotoCurationCenter? = nil) -> LibraryStore {
        LibraryStore(api: api, curation: curation, scope: .event, filters: LibraryFilters(event: filter))
    }
}

/// Maps capture days to the auto event covering them, for naming Library day sections. Only
/// events with a place contribute (a date-range title would repeat the section's date); when
/// two events cover one day, the one with more photos wins. Spans are capped at 31 days.
enum EventDayIndex {
    static func titles(for events: [EventDTO], locale: Locale = .autoupdatingCurrent) -> [String: String] {
        let calendar = OnThisDayDate.utcCalendar
        var winners: [String: (title: String, count: Int)] = [:]
        for event in events {
            guard let place = event.place,
                  let start = EventFormatting.day(event.startAt),
                  let end = EventFormatting.day(event.endAt) else { continue }
            let title = EventFormatting.placeLabel(place)
            var day = min(start, end)
            let last = max(start, end)
            var steps = 0
            while day <= last, steps < 31 {
                let parts = calendar.dateComponents([.year, .month, .day], from: day)
                let key = key(year: parts.year ?? 1, month: parts.month ?? 1, day: parts.day ?? 1)
                if (winners[key]?.count ?? -1) < event.photoCount {
                    winners[key] = (title, event.photoCount)
                }
                guard let next = calendar.date(byAdding: .day, value: 1, to: day) else { break }
                day = next
                steps += 1
            }
        }
        return winners.mapValues(\.title)
    }

    static func key(year: Int, month: Int, day: Int) -> String {
        String(format: "%04d-%02d-%02d", year, month, day)
    }
}
