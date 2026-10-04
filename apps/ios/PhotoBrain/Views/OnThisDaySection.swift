import SwiftUI

/// Library's horizontally scrolling "On this day" cards; tapping one applies its capture date.
struct OnThisDaySection: View {
    let cards: [OnThisDayCard]
    let select: (OnThisDayCard) -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text("On this day")
                .font(.subheadline.weight(.semibold))
                .padding(.horizontal, 14)
                .accessibilityAddTraits(.isHeader)
            ScrollView(.horizontal, showsIndicators: false) {
                LazyHStack(spacing: 10) {
                    ForEach(cards) { card in
                        Button {
                            select(card)
                        } label: {
                            OnThisDayCardView(card: card)
                        }
                        .buttonStyle(.plain)
                    }
                }
                .padding(.horizontal, 14)
            }
        }
        .padding(.vertical, 8)
    }
}

private struct OnThisDayCardView: View {
    let card: OnThisDayCard

    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            CollectionCoverImage(photoID: card.coverPhotoID, url: card.coverURL)
                .frame(width: 128, height: 96)
                .clipShape(RoundedRectangle(cornerRadius: 10))
                .padding(.bottom, 4)
            Text(card.yearsAgoText)
                .font(.subheadline.weight(.semibold))
            Text(card.dateText)
                .font(.caption)
            Text(card.countText)
                .font(.caption)
                .foregroundStyle(.secondary)
        }
        .lineLimit(1)
        .frame(width: 128, alignment: .leading)
        .contentShape(Rectangle())
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(card.accessibilityLabel)
        .accessibilityHint("Shows these photos in the library")
        .accessibilityAddTraits(.isButton)
    }
}
