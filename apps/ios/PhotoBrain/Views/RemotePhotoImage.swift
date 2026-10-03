import SwiftUI

struct RemotePhotoImage<Placeholder: View>: View {
    let photo: PhotoRecord
    let url: URL
    let contentMode: ContentMode
    let showsRetry: Bool
    let targetSize: CGSize
    let placeholder: () -> Placeholder

    init(
        photo: PhotoRecord,
        url: URL,
        contentMode: ContentMode,
        showsRetry: Bool = true,
        targetSize: CGSize = CGSize(width: 320, height: 320),
        @ViewBuilder placeholder: @escaping () -> Placeholder
    ) {
        self.photo = photo
        self.url = url
        self.contentMode = contentMode
        self.showsRetry = showsRetry
        self.targetSize = targetSize
        self.placeholder = placeholder
    }

    @State private var image: UIImage?
    @State private var failed = false
    @State private var retryGeneration = 0

    var body: some View {
        Group {
            if let image {
                Image(uiImage: image)
                    .resizable()
                    .aspectRatio(contentMode: contentMode)
                    .accessibilityHidden(true)
            } else {
                placeholder()
            }
        }
        .task(id: TaskIdentity(url: url, generation: retryGeneration)) {
            guard url.host != "photos.example.invalid" else { return }
            failed = false
            do {
                let loader = RedirectAwareImageLoader()
                image = try await loader.image(for: photo, url: url, targetSize: targetSize)
            } catch is CancellationError {
                return
            } catch {
                failed = true
            }
        }
        .overlay {
            if failed && showsRetry {
                Button("Try Again") { retryGeneration += 1 }
                    .buttonStyle(.borderedProminent)
                    .controlSize(.small)
                    .accessibilityLabel("Retry \(photo.filename)")
            }
        }
    }

    private struct TaskIdentity: Hashable {
        let url: URL
        let generation: Int
    }
}
