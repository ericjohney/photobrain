import SwiftUI

/// Navigation value for an auto event.
struct EventRoute: Hashable {
    let card: EventCard

    static func == (lhs: Self, rhs: Self) -> Bool { lhs.card.id == rhs.card.id }
    func hash(into hasher: inout Hasher) { hasher.combine(card.id) }
}

/// Albums-tab Memories: On this day cards (which filter the Library to that date) followed by
/// auto events (which open their own grid), as large cover cards. Hidden while both are empty.
struct MemoriesSection: View {
    @ObservedObject var events: EventsStore
    @ObservedObject var onThisDay: OnThisDayStore
    let apiBaseURL: URL
    let selectDate: (String) -> Void

    var body: some View {
        let days = onThisDay.cards(apiBaseURL: apiBaseURL)
        let eventCards = events.loadState == .loaded ? events.cards(apiBaseURL: apiBaseURL) : []
        if case let .failed(message) = events.loadState, days.isEmpty {
            VStack(alignment: .leading, spacing: PBSpacing.s) {
                PBSectionHeader(title: "Memories")
                    .padding(.horizontal, PBSpacing.l)
                PBBanner(message: message, retry: { Task { await events.load() } })
            }
        } else if !days.isEmpty || !eventCards.isEmpty {
            VStack(alignment: .leading, spacing: PBSpacing.m) {
                PBSectionHeader(title: "Memories")
                    .padding(.horizontal, PBSpacing.l)
                ScrollView(.horizontal, showsIndicators: false) {
                    LazyHStack(alignment: .top, spacing: PBSpacing.m) {
                        ForEach(days) { card in
                            Button {
                                selectDate(card.capturedDate)
                            } label: {
                                CoverCard(title: card.yearsAgoText, subtitle: "\(card.dateText) · \(card.countText)", width: 168, height: 168) {
                                    CollectionCoverImage(photoID: card.coverPhotoID, url: card.coverURL)
                                }
                            }
                            .buttonStyle(.plain)
                            .accessibilityElement(children: .ignore)
                            .accessibilityLabel(card.accessibilityLabel)
                            .accessibilityHint("Shows these photos in the library")
                            .accessibilityAddTraits(.isButton)
                        }
                        ForEach(eventCards) { card in
                            NavigationLink(value: EventRoute(card: card)) {
                                CoverCard(title: card.title, subtitle: card.subtitle, width: 260, height: 168) {
                                    CollectionCoverImage(photoID: card.coverPhotoID, url: card.coverURL)
                                }
                            }
                            .buttonStyle(.plain)
                            .accessibilityElement(children: .ignore)
                            .accessibilityLabel(card.accessibilityLabel)
                            .accessibilityHint("Shows this event’s photos")
                            .accessibilityAddTraits(.isButton)
                        }
                    }
                    .padding(.horizontal, PBSpacing.l)
                }
            }
        }
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
