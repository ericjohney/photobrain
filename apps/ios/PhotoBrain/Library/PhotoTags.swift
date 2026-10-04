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

/// What a loupe chip narrows the Library to.
enum LibraryShortcut: Equatable, Sendable {
    case tag(String)
    case place(PhotoPlaceDTO)
}

/// Closes whatever loupe is presenting a photo and shows the Library filtered to a tag or place.
/// Installed at the app root; presenters that stack extra modals wrap it to close them too.
struct ShowInLibraryAction {
    let handler: @MainActor (LibraryShortcut) -> Void

    @MainActor
    func callAsFunction(_ shortcut: LibraryShortcut) {
        handler(shortcut)
    }
}

private struct ShowInLibraryKey: EnvironmentKey {
    static let defaultValue: ShowInLibraryAction? = nil
}

extension EnvironmentValues {
    var showInLibrary: ShowInLibraryAction? {
        get { self[ShowInLibraryKey.self] }
        set { self[ShowInLibraryKey.self] = newValue }
    }
}
