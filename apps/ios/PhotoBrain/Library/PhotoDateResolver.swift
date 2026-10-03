import Foundation

enum PhotoDateResolver {
    static let calendar: Calendar = {
        var calendar = Calendar(identifier: .gregorian)
        calendar.locale = Locale(identifier: "en_US_POSIX")
        calendar.timeZone = TimeZone(secondsFromGMT: 0)!
        return calendar
    }()
    private static let isoFractionalFormatter: ISO8601DateFormatter = {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter
    }()
    private static let isoInternetFormatter = ISO8601DateFormatter()


    private static let exifTimestampFormatter: DateFormatter = {
        let formatter = DateFormatter()
        formatter.calendar = calendar
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.timeZone = TimeZone(secondsFromGMT: 0)
        formatter.dateFormat = "yyyy:MM:dd HH:mm:ss"
        formatter.isLenient = false
        return formatter
    }()

    private static let exifDateFormatter: DateFormatter = {
        let formatter = DateFormatter()
        formatter.calendar = calendar
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.timeZone = TimeZone(secondsFromGMT: 0)
        formatter.dateFormat = "yyyy:MM:dd"
        formatter.isLenient = false
        return formatter
    }()

    static func parseCaptureDate(_ value: String?) -> Date? {
        guard let value else { return nil }
        return isoFractionalFormatter.date(from: value)
            ?? isoInternetFormatter.date(from: value)
            ?? exifTimestampFormatter.date(from: value)
            ?? exifDateFormatter.date(from: value)
    }

    static func date(for photo: PhotoRecord) -> Date {
        photo.exifDate ?? photo.modifiedDate ?? photo.createdDate ?? .distantPast
    }

    static func sorted(_ photos: [PhotoRecord], by sort: LibrarySort = .captured) -> [PhotoRecord] {
        photos.sorted { left, right in
            if sort == .added {
                return left.id < right.id
            }
            let leftDate = date(for: left)
            let rightDate = date(for: right)
            return leftDate == rightDate ? left.id < right.id : leftDate < rightDate
        }
    }

    static func grouped(
        _ photos: [PhotoRecord],
        grouping: LibraryGrouping = .months,
        sort: LibrarySort = .captured,
        alreadySorted: Bool = false
    ) -> [PhotoSection] {
        let signpost = SpikeSignposts.beginGroup(recordCount: photos.count)
        defer { SpikeSignposts.endGroup(signpost, recordCount: photos.count) }

        let ordered = alreadySorted ? photos : sorted(photos, by: sort)
        guard grouping != .all, sort == .captured else {
            return [
                PhotoSection(
                    id: .init(year: 0, month: 0, discriminator: "all"),
                    title: "",
                    photos: ordered
                ),
            ]
        }
        let buckets = Dictionary(grouping: ordered) { photo -> PhotoSection.ID in
            let components = calendar.dateComponents([.year, .month], from: date(for: photo))
            return PhotoSection.ID(
                year: components.year ?? 1,
                month: grouping == .years ? 0 : (components.month ?? 1),
                discriminator: grouping.rawValue
            )
        }

        return buckets.keys.sorted {
            ($0.year, $0.month) < ($1.year, $1.month)
        }.map { id in
            let title: String
            if grouping == .years {
                title = String(id.year)
            } else {
                let month = calendar.monthSymbols[max(0, min(11, id.month - 1))]
                title = "\(month) \(id.year)"
            }
            return PhotoSection(id: id, title: title, photos: buckets[id] ?? [])
        }
    }
}
