import SwiftUI

/// Navigation value for an auto event.
struct EventRoute: Hashable {
    let card: EventCard

    static func == (lhs: Self, rhs: Self) -> Bool { lhs.card.id == rhs.card.id }
    func hash(into hasher: inout Hasher) { hasher.combine(card.id) }
}

/// Collections-tab Events section: horizontally scrolling cards, newest first. Hidden until the
/// list loads with at least one event, unless the first load failed.
struct EventsSection<Header: View>: View {
    @ObservedObject var store: EventsStore
    let apiBaseURL: URL
    @ViewBuilder let header: () -> Header

    var body: some View {
        switch store.loadState {
        case .idle, .loading:
            EmptyView()
        case let .failed(message):
            VStack(alignment: .leading, spacing: 8) {
                header()
                ErrorBanner(message: message, retry: { Task { await store.load() } })
                    .clipShape(RoundedRectangle(cornerRadius: 8))
            }
        case .loaded where store.events.isEmpty:
            EmptyView()
        case .loaded:
            VStack(alignment: .leading, spacing: 10) {
                header()
                ScrollView(.horizontal, showsIndicators: false) {
                    LazyHStack(alignment: .top, spacing: 12) {
                        ForEach(store.cards(apiBaseURL: apiBaseURL)) { card in
                            NavigationLink(value: EventRoute(card: card)) {
                                EventCardView(card: card)
                            }
                            .buttonStyle(.plain)
                        }
                    }
                }
                .scrollClipDisabled()
            }
        }
    }
}

private struct EventCardView: View {
    let card: EventCard

    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            CollectionCoverImage(photoID: card.coverPhotoID, url: card.coverURL)
                .frame(width: 168, height: 126)
                .clipShape(RoundedRectangle(cornerRadius: 10))
                .padding(.bottom, 4)
            Text(card.title)
                .font(.subheadline.weight(.semibold))
            Text(card.subtitle)
                .font(.caption)
                .foregroundStyle(.secondary)
        }
        .lineLimit(1)
        .frame(width: 168, alignment: .leading)
        .contentShape(Rectangle())
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(card.accessibilityLabel)
        .accessibilityHint("Shows this event’s photos")
        .accessibilityAddTraits(.isButton)
    }
}

/// One auto event's photos with the same grid and loupe as a collection, listed through the
/// `event` filter.
struct EventDetailScreen: View {
    let card: EventCard
    let events: EventsStore
    let collections: CollectionsStore
    let api: any PhotoBrainAPI
    @StateObject private var store: LibraryStore

    init(
        card: EventCard,
        events: EventsStore,
        collections: CollectionsStore,
        curation: PhotoCurationCenter,
        api: any PhotoBrainAPI
    ) {
        self.card = card
        self.events = events
        self.collections = collections
        self.api = api
        _store = StateObject(wrappedValue: LibraryStore.event(card.filter, api: api, curation: curation))
    }

    var body: some View {
        ScopedPhotoGrid(
            store: store,
            collections: collections,
            api: api,
            title: card.title,
            noun: "Event",
            emptyTitle: "No Photos",
            emptyDescription: "This event’s photos are no longer in the library.",
            onRefresh: { await events.load() }
        )
    }
}
