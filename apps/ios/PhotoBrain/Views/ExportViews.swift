import SwiftUI
import UIKit

extension View {
    /// Shows `store`'s download progress with Cancel over this view, then presents the share
    /// sheet for the downloaded file and deletes it when the sheet completes. Errors are left to
    /// the screen's own banner.
    func exportPresentation(_ store: ExportStore) -> some View {
        modifier(ExportPresentationModifier(store: store))
    }
}

private struct ExportPresentationModifier: ViewModifier {
    @ObservedObject var store: ExportStore

    func body(content: Content) -> some View {
        content
            .overlay {
                if case let .downloading(target, progress) = store.state {
                    ExportProgressCard(target: target, progress: progress, cancel: store.cancel)
                        .transition(.opacity)
                }
            }
            .background {
                ActivitySheetPresenter(file: store.readyFile, onComplete: store.finishSharing)
                    .frame(width: 0, height: 0)
                    .accessibilityHidden(true)
            }
    }
}

private struct ExportProgressCard: View {
    let target: ExportTarget
    let progress: ExportProgress?
    let cancel: () -> Void

    private var title: String {
        switch target {
        case .photo(_, .original): "Downloading Original…"
        case .photo: "Preparing Photo…"
        case .collection: "Preparing ZIP…"
        }
    }

    var body: some View {
        VStack(spacing: 12) {
            Text(title)
                .font(.headline)
            if let fraction = progress?.fraction {
                ProgressView(value: fraction)
                    .frame(width: 200)
            } else {
                ProgressView()
            }
            if let progress, progress.received > 0 {
                Text(byteSummary(progress))
                    .font(.caption.monospacedDigit())
                    .foregroundStyle(.secondary)
            }
            Button("Cancel", role: .cancel, action: cancel)
                .buttonStyle(.bordered)
        }
        .padding(20)
        .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 16))
        .accessibilityElement(children: .contain)
    }

    private func byteSummary(_ progress: ExportProgress) -> String {
        let received = progress.received.formatted(.byteCount(style: .file))
        guard let expected = progress.expected else { return received }
        return "\(received) of \(expected.formatted(.byteCount(style: .file)))"
    }
}

/// Presents `UIActivityViewController` for `file` from this view's controller, once per file.
/// `onComplete` runs when the sheet finishes, is dismissed, or cannot be presented.
private struct ActivitySheetPresenter: UIViewControllerRepresentable {
    let file: ExportFile?
    let onComplete: () -> Void

    func makeUIViewController(context: Context) -> Controller {
        Controller()
    }

    func updateUIViewController(_ controller: Controller, context: Context) {
        controller.onComplete = onComplete
        controller.file = file
    }

    final class Controller: UIViewController {
        var onComplete: (() -> Void)?
        var file: ExportFile? {
            didSet { presentIfNeeded() }
        }
        private var presentedFile: ExportFile?

        override func viewDidAppear(_ animated: Bool) {
            super.viewDidAppear(animated)
            presentIfNeeded()
        }

        private func presentIfNeeded() {
            guard let file, file != presentedFile, viewIfLoaded?.window != nil else { return }
            presentedFile = file
            let activity = UIActivityViewController(activityItems: [file.url], applicationActivities: nil)
            activity.completionWithItemsHandler = { [weak self] _, _, _, _ in
                self?.complete(file)
            }
            if let popover = activity.popoverPresentationController {
                popover.sourceView = view
                popover.sourceRect = view.bounds
                popover.permittedArrowDirections = []
            }
            let presenter = topmostPresenter()
            guard presenter.presentedViewController == nil else {
                complete(file)
                return
            }
            presenter.present(activity, animated: true)
        }

        /// The view controller currently on screen above this one, e.g. the loupe's cover.
        private func topmostPresenter() -> UIViewController {
            var presenter: UIViewController = self
            while let presented = presenter.presentedViewController, !presented.isBeingDismissed {
                presenter = presented
            }
            return presenter
        }

        private func complete(_ file: ExportFile) {
            guard presentedFile == file else { return }
            presentedFile = nil
            onComplete?()
        }
    }
}
