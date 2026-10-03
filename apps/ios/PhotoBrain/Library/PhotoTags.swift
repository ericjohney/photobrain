import Foundation
import SwiftUI

/// User-facing rendering of auto tag slugs.
enum PhotoTagName {
    /// Hyphens become spaces and only the first letter is capitalized (`night-sky` -> `Night sky`).
    static func displayName(_ slug: String) -> String {
        let words = slug.split(separator: "-")
        guard let first = words.first else { return slug }
        return first.prefix(1).uppercased() + words.joined(separator: " ").dropFirst()
    }

    /// Compact filter chip/summary form, e.g. `#beach`.
    static func hashtag(_ slug: String) -> String {
        "#\(slug)"
    }
}

/// Backs the tag chips in the loupe's info sheet for one photo.
@MainActor
final class PhotoTagsStore: ObservableObject {
    enum State: Equatable {
        case loading
        case loaded([PhotoTagDTO])
        case failed(String)
    }

    let photoID: Int
    @Published private(set) var state: State = .loading
    private let api: any PhotoBrainAPI

    init(photoID: Int, api: any PhotoBrainAPI) {
        self.photoID = photoID
        self.api = api
    }

    func load() async {
        state = .loading
        do {
            state = .loaded(try await api.photoTags(id: photoID).tags)
        } catch is CancellationError {
            return
        } catch {
            state = .failed((error as? LocalizedError)?.errorDescription ?? error.localizedDescription)
        }
    }
}

/// Closes whatever loupe is presenting a photo and shows the Library filtered to a tag.
/// Installed at the app root; presenters that stack extra modals wrap it to close them too.
struct ShowTagInLibraryAction {
    let handler: @MainActor (String) -> Void

    @MainActor
    func callAsFunction(_ tag: String) {
        handler(tag)
    }
}

private struct ShowTagInLibraryKey: EnvironmentKey {
    static let defaultValue: ShowTagInLibraryAction? = nil
}

extension EnvironmentValues {
    var showTagInLibrary: ShowTagInLibraryAction? {
        get { self[ShowTagInLibraryKey.self] }
        set { self[ShowTagInLibraryKey.self] = newValue }
    }
}
