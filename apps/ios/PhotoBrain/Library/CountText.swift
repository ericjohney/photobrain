import Foundation

/// Counted nouns for visible text and VoiceOver: `1 photo`, `1,234 photos`.
enum CountText {
    static func photos(_ count: Int) -> String {
        of(count, "photo", "photos")
    }

    /// `count` with the singular noun only for exactly one, digits grouped for the locale.
    static func of(_ count: Int, _ singular: String, _ plural: String) -> String {
        count == 1 ? "1 \(singular)" : "\(count.formatted()) \(plural)"
    }
}
