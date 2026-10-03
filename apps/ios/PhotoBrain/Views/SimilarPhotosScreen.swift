import SwiftUI

struct SimilarPhotosScreen: View {
    let source: PhotoRecord
    let api: any PhotoBrainAPI
    let collections: CollectionsStore
    let dismiss: () -> Void
    @StateObject private var store: SimilarPhotosStore

    init(
        source: PhotoRecord,
        api: any PhotoBrainAPI,
        curation: PhotoCurationCenter,
        collections: CollectionsStore,
        dismiss: @escaping () -> Void
    ) {
        self.source = source
        self.api = api
        self.collections = collections
        self.dismiss = dismiss
        _store = StateObject(wrappedValue: SimilarPhotosStore(api: api, curation: curation))
    }

    var body: some View {
        NavigationStack {
            GeometryReader { geometry in
                content(width: geometry.size.width)
            }
            .navigationTitle("Similar Photos")
            .navigationBarTitleDisplayMode(.inline)
            .safeAreaInset(edge: .top, spacing: 0) {
                Text("Similar to \(source.filename)")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
                    .truncationMode(.middle)
                    .frame(maxWidth: .infinity)
                    .padding(.bottom, 6)
            }
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done", action: dismiss)
                }
            }
        }
        .onAppear { store.load(sourceID: source.id) }
        .onChange(of: source.id) { _, newID in store.load(sourceID: newID) }
        .onDisappear { store.cancel() }
        .fullScreenCover(isPresented: loupePresented) {
            if let activeID = store.activePhotoID {
                LoupeScreen(
                    records: store.records,
                    activeID: Binding(
                        get: { store.activePhotoID ?? activeID },
                        set: { store.activePhotoID = $0 }
                    ),
                    api: api,
                    curation: store.curation,
                    collections: collections,
                    dismiss: { store.activePhotoID = nil }
                )
            }
        }
    }

    @ViewBuilder
    private func content(width: CGFloat) -> some View {
        switch store.state {
        case .idle, .loading:
            ProgressView("Finding similar photos…")
                .frame(maxWidth: .infinity, maxHeight: .infinity)
        case .notIndexed:
            ContentUnavailableView(
                "Not Indexed Yet",
                systemImage: "sparkle.magnifyingglass",
                description: Text("This photo hasn't been indexed yet. Run a scan to enable similar-photo search.")
            )
        case .empty:
            ContentUnavailableView(
                "No Similar Photos",
                systemImage: "sparkle.magnifyingglass",
                description: Text("No other indexed photos are available to compare.")
            )
        case let .failed(message):
            ContentUnavailableView {
                Label("Similar Photos Unavailable", systemImage: "wifi.exclamationmark")
            } description: {
                Text(message)
            } actions: {
                Button("Try Again") { store.retry() }
                    .buttonStyle(.borderedProminent)
            }
        case .loaded:
            PhotoResultsGrid(records: store.records, width: width) { store.activePhotoID = $0 }
        }
    }

    private var loupePresented: Binding<Bool> {
        Binding(
            get: { store.activePhotoID != nil },
            set: { if !$0 { store.activePhotoID = nil } }
        )
    }
}
