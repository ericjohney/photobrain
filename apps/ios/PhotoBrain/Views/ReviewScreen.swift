import SwiftUI

/// Junk review pushed from the Library: reason filter with counts, a paginated grid with
/// reason badges, select mode, bulk Reject All / Keep All, and a loupe with Reject/Keep.
struct ReviewScreen: View {
    @ObservedObject var store: ReviewStore
    let collections: CollectionsStore
    @State private var confirmation: JunkAction?
    @State private var hasLoaded = false

    var body: some View {
        GeometryReader { geometry in
            content(width: geometry.size.width)
        }
        .navigationTitle("Review")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar(.visible, for: .navigationBar)
        .toolbar(.hidden, for: .tabBar)
        .safeAreaInset(edge: .top, spacing: 0) {
            VStack(spacing: 0) {
                ReasonPicker(selection: store.reason, counts: store.counts) { store.setReason($0) }
                if let message = store.errorMessage {
                    ErrorBanner(message: message, dismiss: { store.dismissError() })
                }
            }
            .background(.bar)
        }
        .safeAreaInset(edge: .bottom, spacing: 0) {
            if !store.records.isEmpty { actionBar }
        }
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                if store.isSelecting {
                    Button("Done") { store.endSelection() }
                        .fontWeight(.semibold)
                        .accessibilityLabel("Finish selecting photos")
                } else {
                    Button("Select") { store.beginSelection() }
                        .disabled(store.records.isEmpty)
                        .accessibilityLabel("Select photos")
                }
            }
        }
        .task {
            // Each push starts from a fresh first page; returning from the loupe keeps the list.
            guard !hasLoaded else { return }
            hasLoaded = true
            store.load(retainingContent: false)
        }
        .confirmationDialog(
            confirmationTitle,
            isPresented: confirmationPresented,
            titleVisibility: .visible,
            presenting: confirmation
        ) { action in
            Button(action == .reject ? "Reject \(photoCount(store.records.count))" : "Keep \(photoCount(store.records.count))",
                   role: action == .reject ? .destructive : nil) {
                store.resolveAll(action)
            }
            Button("Cancel", role: .cancel) {}
        } message: { action in
            Text(action == .reject
                ? "Marks every photo shown here as rejected. Files are not deleted."
                : "Keeps every photo shown here and removes them from Review for good.")
        }
        .fullScreenCover(isPresented: loupePresented) {
            if let activeID = store.activePhotoID {
                LoupeScreen(
                    records: store.records,
                    activeID: Binding(
                        get: { store.activePhotoID ?? activeID },
                        set: { store.activePhotoID = $0 }
                    ),
                    api: store.api,
                    curation: store.curation,
                    collections: collections,
                    dismiss: { store.activePhotoID = nil },
                    review: LoupeReviewActions(
                        errorMessage: store.errorMessage,
                        resolve: { store.resolveActive($0) },
                        dismissError: { store.dismissError() }
                    )
                )
            }
        }
    }

    @ViewBuilder
    private func content(width: CGFloat) -> some View {
        switch store.state {
        case .idle, .loading:
            ProgressView("Loading Review…")
                .frame(maxWidth: .infinity, maxHeight: .infinity)
        case let .failed(message):
            ContentUnavailableView {
                Label("Review Unavailable", systemImage: "wifi.exclamationmark")
            } description: {
                Text(message)
            } actions: {
                Button("Try Again") { store.load() }
                    .buttonStyle(.borderedProminent)
            }
        case .loaded where store.records.isEmpty:
            ScrollView {
                if store.nextCursor == nil {
                    ContentUnavailableView(
                        "Nothing to review",
                        systemImage: "checkmark.circle",
                        description: Text(store.reason == nil
                            ? "No screenshots, documents, blurry, or dark photos are waiting."
                            : "No photos are waiting in \(store.reason?.title ?? "this category").")
                    )
                    .padding(.top, 60)
                } else {
                    ProgressView()
                        .padding(.top, 60)
                }
            }
            .refreshable { await store.load().value }
        case .loaded:
            ReviewGrid(store: store, width: width)
        }
    }

    private var actionBar: some View {
        HStack(spacing: 12) {
            if store.isSelecting {
                Button(role: .destructive) {
                    store.resolveSelected(.reject)
                } label: {
                    Label("Reject \(store.selectedCount)", systemImage: "xmark.circle")
                        .frame(maxWidth: .infinity)
                }
                .disabled(store.selectedIDs.isEmpty)
                .accessibilityLabel("Reject \(photoCount(store.selectedCount))")
                Button {
                    store.resolveSelected(.keep)
                } label: {
                    Label("Keep \(store.selectedCount)", systemImage: "checkmark.circle")
                        .frame(maxWidth: .infinity)
                }
                .disabled(store.selectedIDs.isEmpty)
                .accessibilityLabel("Keep \(photoCount(store.selectedCount))")
            } else {
                Button(role: .destructive) {
                    confirmation = .reject
                } label: {
                    Text("Reject All (\(store.records.count))")
                        .frame(maxWidth: .infinity)
                }
                Button {
                    confirmation = .keep
                } label: {
                    Text("Keep All (\(store.records.count))")
                        .frame(maxWidth: .infinity)
                }
            }
        }
        .buttonStyle(.bordered)
        .controlSize(.large)
        .padding(.horizontal, 12)
        .padding(.vertical, 8)
        .background(.bar)
    }

    private var confirmationTitle: String {
        switch confirmation {
        case .reject: "Reject \(photoCount(store.records.count))?"
        case .keep: "Keep \(photoCount(store.records.count))?"
        case nil: ""
        }
    }

    private func photoCount(_ count: Int) -> String {
        count == 1 ? "1 Photo" : "\(count.formatted()) Photos"
    }

    private var confirmationPresented: Binding<Bool> {
        Binding(get: { confirmation != nil }, set: { if !$0 { confirmation = nil } })
    }

    private var loupePresented: Binding<Bool> {
        Binding(
            get: { store.activePhotoID != nil },
            set: { if !$0 { store.activePhotoID = nil } }
        )
    }
}

/// Horizontally scrolling segmented control: All plus each reason, each with its count.
private struct ReasonPicker: View {
    let selection: JunkReason?
    let counts: JunkCountsDTO
    let select: (JunkReason?) -> Void

    var body: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 6) {
                segment(nil, title: "All")
                ForEach(JunkReason.allCases) { reason in
                    segment(reason, title: reason.title)
                }
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 8)
        }
    }

    private func segment(_ reason: JunkReason?, title: String) -> some View {
        let isSelected = selection == reason
        let count = counts.count(for: reason)
        return Button {
            select(reason)
        } label: {
            HStack(spacing: 4) {
                Text(title)
                Text(count.formatted())
                    .monospacedDigit()
                    .foregroundStyle(isSelected ? Color.white.opacity(0.85) : Color.secondary)
                    .contentTransition(.numericText())
            }
            .font(.subheadline.weight(isSelected ? .semibold : .regular))
            .padding(.horizontal, 12)
            .padding(.vertical, 6)
            .foregroundStyle(isSelected ? Color.white : Color.primary)
            .background(
                Capsule().fill(isSelected ? Color.accentColor : Color(uiColor: .secondarySystemFill))
            )
        }
        .buttonStyle(.plain)
        .accessibilityLabel("\(title), \(count)")
        .accessibilityAddTraits(isSelected ? .isSelected : [])
    }
}

/// Lazily loaded review grid; requests the next page as its last cells appear.
private struct ReviewGrid: View {
    @ObservedObject var store: ReviewStore
    let width: CGFloat

    var body: some View {
        let columns = PhotoResultsGrid.columnCount(width: width)
        let side = width / CGFloat(columns)
        ScrollView {
            LazyVGrid(
                columns: Array(repeating: GridItem(.flexible(), spacing: 1), count: columns),
                spacing: 1
            ) {
                ForEach(store.records) { photo in
                    cell(photo, side: side)
                        .onAppear { store.loadMoreIfNeeded(after: photo.id) }
                }
            }
            if store.isLoadingMore {
                ProgressView()
                    .padding()
            }
        }
        .refreshable { await store.load().value }
    }

    private func cell(_ photo: PhotoRecord, side: CGFloat) -> some View {
        let isSelected = store.selectedIDs.contains(photo.id)
        let reasons = photo.junkReasons.map(\.title).joined(separator: ", ")
        return Button {
            store.activate(photo.id)
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
            .overlay(alignment: .bottomLeading) {
                if let reason = photo.junkReasons.first {
                    Text(reason.title)
                        .font(.caption2.weight(.semibold))
                        .foregroundStyle(.white)
                        .padding(.horizontal, 5)
                        .padding(.vertical, 2)
                        .background(RoundedRectangle(cornerRadius: 4).fill(Color.black.opacity(0.72)))
                        .padding(4)
                        .accessibilityHidden(true)
                }
            }
            .overlay(alignment: .bottomTrailing) { CurationBadge(rating: photo.rating, flag: photo.flag) }
            .overlay {
                if store.isSelecting {
                    ZStack(alignment: .topTrailing) {
                        Color.white.opacity(isSelected ? 0.25 : 0)
                        Image(systemName: isSelected ? "checkmark.circle.fill" : "circle")
                            .font(.title3)
                            .symbolRenderingMode(.palette)
                            .foregroundStyle(.white, isSelected ? Color.accentColor : Color.black.opacity(0.3))
                            .padding(5)
                    }
                    .accessibilityHidden(true)
                }
            }
        }
        .buttonStyle(.plain)
        .accessibilityLabel("\(photo.filename), \(reasons)")
        .accessibilityAddTraits(store.isSelecting && isSelected ? .isSelected : [])
    }
}
