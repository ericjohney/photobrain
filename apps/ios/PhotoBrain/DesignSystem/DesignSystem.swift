import SwiftUI
import UIKit

// PhotoBrain's thin design layer over the platform: spacing, radii, semantic colors, Liquid
// Glass chrome with pre-iOS 26 fallbacks, and the small shared components every screen reuses.
// Prefer system text styles and SF Symbols directly; add a token here only when a value is
// shared by more than one screen.

enum PBSpacing {
    static let xxs: CGFloat = 2
    static let xs: CGFloat = 4
    static let s: CGFloat = 8
    static let m: CGFloat = 12
    static let l: CGFloat = 16
    static let xl: CGFloat = 24
}

enum PBRadius {
    /// Grid and thumbnail overlay badges.
    static let badge: CGFloat = 5
    /// Filmstrip frames and small thumbnails.
    static let thumbnail: CGFloat = 6
    /// Album and person cover cards.
    static let card: CGFloat = 14
    /// Large memory covers.
    static let hero: CGFloat = 18
}

enum PBColor {
    /// The brand tint, from the `AccentColor` asset.
    static let accent = Color.accentColor
    static let rating = Color.yellow
    static let pick = Color.green
    static let reject = Color.red
    static let warning = Color.orange
    /// Unselected chip and placeholder fill.
    static let chipFill = Color(uiColor: .tertiarySystemFill)
    /// Behind white overlay text on photos (badges).
    static let badgeBackground = Color.black.opacity(0.5)
    static let uiBadgeBackground = UIColor.black.withAlphaComponent(0.5)
}

enum PBSize {
    /// Minimum hit target for icon-only controls.
    static let control: CGFloat = 44
    /// Album/smart album tiles in horizontal rows.
    static let albumTile: CGFloat = 132
    /// People avatars in horizontal rows.
    static let avatar: CGFloat = 64
}

// MARK: - Glass

extension View {
    /// Liquid Glass on iOS 26, a material on earlier releases, and an opaque fill when
    /// Reduce Transparency is on.
    func pbGlass<S: Shape>(in shape: S, interactive: Bool = false, dark: Bool = false) -> some View {
        modifier(PBGlassModifier(shape: shape, interactive: interactive, dark: dark))
    }
}

private struct PBGlassModifier<S: Shape>: ViewModifier {
    let shape: S
    let interactive: Bool
    let dark: Bool
    @Environment(\.accessibilityReduceTransparency) private var reduceTransparency

    func body(content: Content) -> some View {
        if reduceTransparency {
            content.background(shape.fill(dark ? Color.black.opacity(0.9) : Color(uiColor: .secondarySystemBackground)))
        } else if #available(iOS 26.0, *) {
            content.glassEffect(interactive ? .regular.interactive() : .regular, in: shape)
        } else {
            content.background(shape.fill(dark ? AnyShapeStyle(Color.black.opacity(0.45)) : AnyShapeStyle(.regularMaterial)))
        }
    }
}

/// A round, icon-only glass button with a 44 pt hit target.
struct GlassIconButton: View {
    let systemImage: String
    let accessibilityLabel: String
    var dark = false
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            GlassIconLabel(systemImage: systemImage, dark: dark)
        }
        .buttonStyle(.plain)
        .accessibilityLabel(accessibilityLabel)
    }
}

/// The visual of `GlassIconButton`, for use as a `Menu` label.
struct GlassIconLabel: View {
    let systemImage: String
    var dark = false

    var body: some View {
        Image(systemName: systemImage)
            .font(.body.weight(.semibold))
            .foregroundStyle(dark ? Color.white : Color.primary)
            .frame(width: PBSize.control, height: PBSize.control)
            .pbGlass(in: Circle(), interactive: true, dark: dark)
            .contentShape(Circle())
    }
}

// MARK: - Chips

/// A capsule filter chip. Selected chips use the accent fill.
struct FilterChip: View {
    let title: String
    var systemImage: String?
    var isOn = false
    /// Shows a trailing xmark, for chips that remove a filter.
    var removable = false
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            HStack(spacing: PBSpacing.xs) {
                if let systemImage { Image(systemName: systemImage) }
                Text(title).lineLimit(1)
                if removable {
                    Image(systemName: "xmark")
                        .font(.caption2.weight(.bold))
                }
            }
            .font(.subheadline.weight(.medium))
            .padding(.horizontal, PBSpacing.m)
            .padding(.vertical, 7)
            .foregroundStyle(isOn ? Color.white : Color.primary)
            .background(Capsule().fill(isOn ? PBColor.accent : PBColor.chipFill))
            .contentShape(Capsule())
        }
        .buttonStyle(.plain)
        .accessibilityAddTraits(isOn ? .isSelected : [])
    }
}

// MARK: - Banners

/// Inline warning or error with optional Retry and dismiss controls.
struct PBBanner: View {
    let message: String
    var systemImage = "exclamationmark.triangle.fill"
    var retry: (() -> Void)?
    var dismiss: (() -> Void)?

    var body: some View {
        HStack(spacing: PBSpacing.s) {
            Image(systemName: systemImage)
                .foregroundStyle(PBColor.warning)
            Text(message)
                .lineLimit(3)
                .frame(maxWidth: .infinity, alignment: .leading)
            if let retry {
                Button("Retry", action: retry)
                    .fontWeight(.semibold)
            }
            if let dismiss {
                Button(action: dismiss) {
                    Image(systemName: "xmark")
                        .frame(width: 32, height: 32)
                }
                .accessibilityLabel("Dismiss error")
            }
        }
        .font(.footnote)
        .padding(.horizontal, PBSpacing.m)
        .padding(.vertical, PBSpacing.s)
        .background(
            RoundedRectangle(cornerRadius: PBRadius.card, style: .continuous)
                .fill(PBColor.warning.opacity(0.16))
        )
        .padding(.horizontal, PBSpacing.m)
        .padding(.vertical, PBSpacing.xs)
    }
}

// MARK: - Sections and cards

/// A titled horizontal section header with an optional trailing action.
struct PBSectionHeader<Trailing: View>: View {
    let title: String
    @ViewBuilder var trailing: () -> Trailing

    var body: some View {
        HStack(alignment: .firstTextBaseline) {
            Text(title)
                .font(.title3.weight(.bold))
                .accessibilityAddTraits(.isHeader)
            Spacer()
            trailing()
                .font(.subheadline)
        }
    }
}

extension PBSectionHeader where Trailing == EmptyView {
    init(title: String) {
        self.title = title
        trailing = { EmptyView() }
    }
}

/// A cover photo with a bottom gradient and overlaid title, for memories and browse tiles.
struct CoverCard<Cover: View>: View {
    let title: String
    var subtitle: String?
    var width: CGFloat
    var height: CGFloat
    @ViewBuilder var cover: () -> Cover

    var body: some View {
        cover()
            .frame(width: width, height: height)
            .overlay {
                LinearGradient(
                    colors: [.clear, .black.opacity(0.6)],
                    startPoint: .center,
                    endPoint: .bottom
                )
            }
            .overlay(alignment: .bottomLeading) {
                VStack(alignment: .leading, spacing: 1) {
                    Text(title)
                        .font(.headline)
                        .lineLimit(2)
                        .minimumScaleFactor(0.8)
                    if let subtitle {
                        Text(subtitle)
                            .font(.caption.weight(.medium))
                            .lineLimit(1)
                            .opacity(0.9)
                    }
                }
                .foregroundStyle(.white)
                .shadow(color: .black.opacity(0.3), radius: 3, y: 1)
                .padding(PBSpacing.m)
            }
            .clipShape(RoundedRectangle(cornerRadius: PBRadius.hero, style: .continuous))
            .contentShape(RoundedRectangle(cornerRadius: PBRadius.hero, style: .continuous))
    }
}

extension View {
    /// The iOS 26 navigation subtitle under the title; a no-op on earlier releases.
    @ViewBuilder
    func pbNavigationSubtitle(_ subtitle: String) -> some View {
        if #available(iOS 26.0, *), !subtitle.isEmpty {
            navigationSubtitle(subtitle)
        } else {
            self
        }
    }
}
