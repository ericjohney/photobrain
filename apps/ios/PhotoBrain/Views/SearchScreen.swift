import SwiftUI

struct SearchScreen: View {
    @ObservedObject var store: SearchStore
    let api: any PhotoBrainAPI

    var body: some View {
        NavigationStack {
            GeometryReader { geometry in
                content(width: geometry.size.width)
            }
            .navigationTitle("Search")
            .navigationBarTitleDisplayMode(.large)
            .searchable(
                text: $store.query,
                placement: .navigationBarDrawer(displayMode: .always),
                prompt: "Search Photos"
            )
            .textInputAutocapitalization(.never)
            .autocorrectionDisabled()
        }
        .fullScreenCover(isPresented: loupePresented) {
            if let activeID = store.activePhotoID {
                LoupeScreen(
                    records: store.records,
                    activeID: Binding(
                        get: { store.activePhotoID ?? activeID },
                        set: { store.activePhotoID = $0 }
                    ),
                    api: api,
                    dismiss: { store.activePhotoID = nil }
                )
            }
        }
    }

    @ViewBuilder
    private func content(width: CGFloat) -> some View {
        switch store.state {
        case .idle:
            ScrollView {
                ContentUnavailableView {
                    Label("Search your library", systemImage: "sparkles")
                } description: {
                    Text("Describe a place, subject, color, or moment. PhotoBrain searches by visual meaning.")
                } actions: {
                    VStack(spacing: 8) {
                        example("sunset on the beach")
                        example("red car")
                        example("mountains in winter")
                    }
                }
                .padding(.top, 40)
            }
        case .waiting, .loading:
            ProgressView("Searching…")
                .frame(maxWidth: .infinity, maxHeight: .infinity)
        case .empty:
            ContentUnavailableView(
                "No Results",
                systemImage: "magnifyingglass",
                description: Text("Try a broader description or a different phrase.")
            )
        case let .failed(message):
            ContentUnavailableView {
                Label("Search Unavailable", systemImage: "wifi.exclamationmark")
            } description: {
                Text(message)
            } actions: {
                Button("Try Again") { store.retry() }
                    .buttonStyle(.borderedProminent)
            }
        case .results:
            PhotoResultsGrid(records: store.records, width: width) { store.activePhotoID = $0 }
                .scrollDismissesKeyboard(.interactively)
        }
    }

    private func example(_ query: String) -> some View {
        Button(query) { store.query = query }
            .buttonStyle(.bordered)
    }

    private var loupePresented: Binding<Bool> {
        Binding(
            get: { store.activePhotoID != nil },
            set: { if !$0 { store.activePhotoID = nil } }
        )
    }
}

/// Lazily loaded square thumbnail grid shared by search and similar-photo results.
struct PhotoResultsGrid: View {
    let records: [PhotoRecord]
    let width: CGFloat
    let onSelect: (Int) -> Void

    var body: some View {
        let columns = Self.columnCount(width: width)
        let side = width / CGFloat(columns)
        ScrollView {
            LazyVGrid(
                columns: Array(repeating: GridItem(.flexible(), spacing: 1), count: columns),
                spacing: 1
            ) {
                ForEach(records) { photo in
                    Button {
                        onSelect(photo.id)
                    } label: {
                        RemotePhotoImage(
                            photo: photo,
                            url: photo.thumbnailURL,
                            contentMode: .fill,
                            showsRetry: false,
                            targetSize: CGSize(width: side, height: side)
                        ) {
                            Color(uiColor: SyntheticThumbnail.color(id: photo.id))
                        }
                        .aspectRatio(1, contentMode: .fit)
                        .clipped()
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel("Open \(photo.filename)")
                }
            }
        }
    }

    static func columnCount(width: CGFloat) -> Int {
        switch width {
        case ..<560: 4
        case ..<768: 5
        case ..<1_024: 7
        default: 8
        }
    }
}
