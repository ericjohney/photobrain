import SwiftUI

/// Duplicates and bursts pushed from the Library: kind filter with counts, then one card per
/// group with a horizontal thumbnail strip. The suggested keeper starts kept; tapping toggles
/// keep (one photo always stays kept), long-press or Compare opens a loupe over the group, and
/// each group resolves with "Keep N, reject M" or "Not duplicates".
struct DuplicatesScreen: View {
    @ObservedObject var store: DuplicatesStore
    let collections: CollectionsStore
    @State private var hasLoaded = false

    var body: some View {
        content
            .navigationTitle("Duplicates")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar(.visible, for: .navigationBar)
            .toolbar(.hidden, for: .tabBar)
            .safeAreaInset(edge: .top, spacing: 0) {
                VStack(spacing: 0) {
                    KindPicker(selection: store.kind, counts: store.counts) { store.setKind($0) }
                    if let notice = store.notice {
                        ErrorBanner(message: notice, dismiss: { store.dismissNotice() })
                    }
                    if let message = store.errorMessage {
                        ErrorBanner(message: message, dismiss: { store.dismissError() })
                    }
                }
                .background(.bar)
            }
            .task {
                // Each push starts from a fresh first page; returning from the loupe keeps the list.
                guard !hasLoaded else { return }
                hasLoaded = true
                store.load(retainingContent: false)
            }
            .fullScreenCover(isPresented: comparisonPresented) {
                if let comparison = store.comparison, let group = store.group(for: comparison.key) {
                    LoupeScreen(
                        records: group.photos,
                        activeID: Binding(
                            get: { store.comparison?.photoID ?? comparison.photoID },
                            set: { store.comparison?.photoID = $0 }
                        ),
                        api: store.api,
                        curation: store.curation,
                        collections: collections,
                        dismiss: { store.comparison = nil }
                    )
                }
            }
    }

    @ViewBuilder
    private var content: some View {
        switch store.state {
        case .idle, .loading:
            ProgressView("Loading Duplicates…")
                .frame(maxWidth: .infinity, maxHeight: .infinity)
        case let .failed(message):
            ContentUnavailableView {
                Label("Duplicates Unavailable", systemImage: "wifi.exclamationmark")
            } description: {
                Text(message)
            } actions: {
                Button("Try Again") { store.load() }
                    .buttonStyle(.borderedProminent)
            }
        case .loaded where store.groups.isEmpty:
            ScrollView {
                if store.nextCursor == nil {
                    ContentUnavailableView(
                        "No duplicates",
                        systemImage: "checkmark.circle",
                        description: Text(emptyDescription)
                    )
                    .padding(.top, 60)
                } else {
                    ProgressView()
                        .padding(.top, 60)
                }
            }
            .refreshable { await store.load().value }
        case .loaded:
            ScrollView {
                LazyVStack(spacing: 12) {
                    ForEach(store.groups) { group in
                        DuplicateGroupCard(store: store, group: group)
                            .onAppear { store.loadMoreIfNeeded(after: group.key) }
                    }
                    if store.isLoadingMore {
                        ProgressView()
                            .padding()
                    }
                }
                .padding(.vertical, 12)
            }
            .refreshable { await store.load().value }
        }
    }

    private var emptyDescription: String {
        switch store.kind {
        case nil: "No near-identical photos or bursts are waiting."
        case .duplicate: "No near-identical photos are waiting."
        case .burst: "No bursts are waiting."
        }
    }

    private var comparisonPresented: Binding<Bool> {
        Binding(
            get: { store.comparison != nil },
            set: { if !$0 { store.comparison = nil } }
        )
    }
}

/// Horizontally scrolling segmented control: All, Duplicates, Bursts, each with its group count.
private struct KindPicker: View {
    let selection: DuplicateKind?
    let counts: DuplicateCountsDTO
    let select: (DuplicateKind?) -> Void

    var body: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 6) {
                segment(nil, title: "All")
                ForEach(DuplicateKind.allCases) { kind in
                    segment(kind, title: kind.title)
                }
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 8)
        }
    }

    private func segment(_ kind: DuplicateKind?, title: String) -> some View {
        let isSelected = selection == kind
        let count = counts.count(for: kind)
        return Button {
            select(kind)
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
        .accessibilityLabel("\(title), \(CountText.of(count, "group", "groups"))")
        .accessibilityAddTraits(isSelected ? .isSelected : [])
    }
}

/// One group: header, keep-toggle thumbnail strip, and the two resolve actions.
private struct DuplicateGroupCard: View {
    @ObservedObject var store: DuplicatesStore
    let group: DuplicateGroup

    private static let side: CGFloat = 112

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack {
                Label(
                    group.kind == .burst ? "Burst" : "Duplicates",
                    systemImage: group.kind == .burst ? "square.stack.3d.down.right" : "square.on.square"
                )
                .font(.subheadline.weight(.semibold))
                Text(CountText.photos(group.photos.count))
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                Spacer()
                Button {
                    store.compare(groupKey: group.key, photoID: group.keptIDs.first ?? group.suggestedKeeperID)
                } label: {
                    Label("Compare", systemImage: "rectangle.split.2x1")
                        .font(.subheadline)
                }
                .accessibilityLabel("Compare \(CountText.photos(group.photos.count))")
            }
            .padding(.horizontal, 12)

            ScrollView(.horizontal, showsIndicators: false) {
                LazyHStack(spacing: 6) {
                    ForEach(group.photos) { photo in
                        thumbnail(photo)
                    }
                }
                .padding(.horizontal, 12)
            }
            .frame(height: Self.side)

            HStack(spacing: 12) {
                Button(role: .destructive) {
                    store.keepSelected(groupKey: group.key)
                } label: {
                    Text("Keep \(group.keptIDs.count), reject \(group.rejectedIDs.count)")
                        .frame(maxWidth: .infinity)
                }
                .disabled(group.rejectedIDs.isEmpty)
                Button {
                    store.dismiss(groupKey: group.key)
                } label: {
                    Text("Not duplicates")
                        .frame(maxWidth: .infinity)
                }
            }
            .buttonStyle(.bordered)
            .padding(.horizontal, 12)
        }
        .padding(.vertical, 10)
        .background(RoundedRectangle(cornerRadius: 12).fill(Color(uiColor: .secondarySystemBackground)))
        .padding(.horizontal, 10)
    }

    private func thumbnail(_ photo: PhotoRecord) -> some View {
        let isKept = group.keepIDs.contains(photo.id)
        let isSuggested = photo.id == group.suggestedKeeperID
        return RemotePhotoImage(
            photo: photo,
            url: photo.thumbnailURL,
            contentMode: .fill,
            showsRetry: false,
            targetSize: CGSize(width: Self.side, height: Self.side)
        ) {
            Color(uiColor: SyntheticThumbnail.color(id: photo.id))
        }
        .frame(width: Self.side, height: Self.side)
        .clipped()
        .overlay {
            if !isKept {
                Color.black.opacity(0.45)
                    .accessibilityHidden(true)
            }
        }
        .overlay(alignment: .topTrailing) {
            Image(systemName: isKept ? "checkmark.circle.fill" : "xmark.circle.fill")
                .font(.title3)
                .symbolRenderingMode(.palette)
                .foregroundStyle(.white, isKept ? Color.accentColor : Color.red)
                .padding(5)
                .accessibilityHidden(true)
        }
        .overlay(alignment: .bottomLeading) {
            if isSuggested {
                Text("Suggested")
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
            RoundedRectangle(cornerRadius: 6)
                .strokeBorder(isKept ? Color.accentColor : Color.clear, lineWidth: 3)
        }
        .clipShape(RoundedRectangle(cornerRadius: 6))
        .contentShape(Rectangle())
        .onTapGesture { store.toggleKeep(groupKey: group.key, photoID: photo.id) }
        .onLongPressGesture { store.compare(groupKey: group.key, photoID: photo.id) }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("\(photo.filename)\(isSuggested ? ", suggested" : ""), \(isKept ? "keep" : "reject")")
        .accessibilityAddTraits(.isButton)
        .accessibilityAddTraits(isKept ? .isSelected : [])
        .accessibilityAction { store.toggleKeep(groupKey: group.key, photoID: photo.id) }
        .accessibilityAction(named: "Compare") { store.compare(groupKey: group.key, photoID: photo.id) }
    }
}
