import SwiftUI

/// Library Gear Stats sheet: cameras, lenses, exposure histograms, and shots per year over the
/// Library's current filters. Tapping a camera or lens dismisses the sheet and hands it to
/// `select`, which applies the Library's `camera`/`lens` filter.
struct GearStatsScreen: View {
    let select: (GearSelection) -> Void
    @StateObject private var store: GearStatsStore
    @Environment(\.dismiss) private var dismiss
    @State private var showsAllCameras = false
    @State private var showsAllLenses = false

    init(filters: LibraryFilters, api: any PhotoBrainAPI, select: @escaping (GearSelection) -> Void) {
        self.select = select
        _store = StateObject(wrappedValue: GearStatsStore(filters: filters, api: api))
    }

    var body: some View {
        NavigationStack {
            content
                .navigationTitle("Gear Stats")
                .navigationBarTitleDisplayMode(.inline)
                .toolbar {
                    ToolbarItem(placement: .confirmationAction) {
                        Button("Done") { dismiss() }
                    }
                }
        }
        .task {
            if store.state == .idle { await store.load() }
        }
    }

    @ViewBuilder
    private var content: some View {
        switch store.state {
        case .idle, .loading:
            ProgressView("Loading Gear Stats…")
                .frame(maxWidth: .infinity, maxHeight: .infinity)
        case let .failed(message):
            ContentUnavailableView {
                Label("Gear Stats Unavailable", systemImage: "wifi.exclamationmark")
            } description: {
                Text(message)
            } actions: {
                Button("Try Again") { Task { await store.load() } }
                    .buttonStyle(.borderedProminent)
            }
        case .empty:
            ContentUnavailableView(
                GearStatsPresentation.emptyText,
                systemImage: "camera",
                description: store.filters.isActive ? Text("Try clearing one or more filters.") : nil
            )
        case .loaded:
            if let stats = store.stats { statsList(stats) }
        }
    }

    private func statsList(_ stats: GearStatsDTO) -> some View {
        List {
            Section {
                Text(GearStatsPresentation.headerText(total: stats.total, withExif: stats.withExif))
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
            }
            countSection("Cameras", counts: stats.cameras, showsAll: $showsAllCameras, selection: GearSelection.camera)
            countSection("Lenses", counts: stats.lenses, showsAll: $showsAllLenses, selection: GearSelection.lens)
            bucketSection("Focal Length", buckets: stats.focalLengths)
            bucketSection("Aperture", buckets: stats.apertures)
            bucketSection("Shutter Speed", buckets: stats.shutterSpeeds)
            bucketSection("ISO", buckets: stats.isos)
            yearSection(GearStatsPresentation.yearBreakdown(stats.cameraYears))
        }
    }

    @ViewBuilder
    private func countSection(
        _ title: String,
        counts: [GearCountDTO],
        showsAll: Binding<Bool>,
        selection: @escaping (String) -> GearSelection
    ) -> some View {
        if !counts.isEmpty {
            Section(title) {
                let maximum = counts.first?.count ?? 0
                ForEach(GearStatsPresentation.visible(counts, showAll: showsAll.wrappedValue), id: \.label) { entry in
                    Button {
                        select(selection(entry.label))
                        dismiss()
                    } label: {
                        GearBarRow(
                            label: entry.label,
                            count: entry.count,
                            fraction: GearStatsPresentation.fraction(entry.count, of: maximum)
                        )
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel(GearStatsPresentation.accessibilityLabel(entry))
                    .accessibilityHint("Shows these photos in the Library")
                }
                if GearStatsPresentation.hasMore(counts) {
                    Button(showsAll.wrappedValue ? "Show Fewer" : "Show All \(counts.count.formatted())") {
                        showsAll.wrappedValue.toggle()
                    }
                }
            }
        }
    }

    private func bucketSection(_ title: String, buckets: [GearBucketDTO]) -> some View {
        Section(title) {
            let maximum = buckets.map(\.count).max() ?? 0
            ForEach(buckets, id: \.label) { bucket in
                GearBarRow(
                    label: bucket.label,
                    count: bucket.count,
                    fraction: GearStatsPresentation.fraction(bucket.count, of: maximum)
                )
                .accessibilityElement(children: .ignore)
                .accessibilityLabel(GearStatsPresentation.accessibilityLabel(bucket))
            }
        }
    }

    private func yearSection(_ breakdown: GearStatsPresentation.YearBreakdown) -> some View {
        Section("Shots per Year") {
            if breakdown.isEmpty {
                Text(GearStatsPresentation.noDatedCameraText)
                    .foregroundStyle(.secondary)
            } else {
                YearLegend(cameras: breakdown.cameras, hasOther: breakdown.hasOther)
                ForEach(breakdown.years) { year in
                    YearShotsRow(year: year, maximum: breakdown.maximumTotal)
                }
            }
        }
    }
}

/// Label, count, and a proportional horizontal bar; a zero count draws an empty track.
private struct GearBarRow: View {
    let label: String
    let count: Int
    let fraction: Double

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack {
                Text(label)
                    .lineLimit(1)
                Spacer()
                Text(count.formatted())
                    .monospacedDigit()
                    .foregroundStyle(.secondary)
            }
            .font(.subheadline)
            GeometryReader { proxy in
                ZStack(alignment: .leading) {
                    Capsule().fill(Color.secondary.opacity(0.15))
                    Capsule()
                        .fill(Color.accentColor)
                        .frame(width: proxy.size.width * fraction)
                }
            }
            .frame(height: 6)
        }
        .contentShape(Rectangle())
    }
}

private enum YearPalette {
    static let cameras: [Color] = [.blue, .orange, .green, .purple, .pink]
    static let other = Color.gray

    static func color(_ cameraIndex: Int?) -> Color {
        guard let cameraIndex else { return other }
        return cameras[cameraIndex % cameras.count]
    }
}

private struct YearLegend: View {
    let cameras: [String]
    let hasOther: Bool

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            ForEach(Array(cameras.enumerated()), id: \.offset) { index, camera in
                entry(camera, color: YearPalette.color(index))
            }
            if hasOther {
                entry(GearStatsPresentation.otherLabel, color: YearPalette.other)
            }
        }
        .font(.caption)
        .accessibilityHidden(true)
    }

    private func entry(_ label: String, color: Color) -> some View {
        HStack(spacing: 6) {
            Circle().fill(color).frame(width: 8, height: 8)
            Text(label).lineLimit(1)
        }
    }
}

/// One year: its total and a bar segmented by camera, scaled to the busiest year.
private struct YearShotsRow: View {
    let year: GearStatsPresentation.YearShots
    let maximum: Int

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack {
                Text(String(year.year))
                Spacer()
                Text(year.total.formatted())
                    .monospacedDigit()
                    .foregroundStyle(.secondary)
            }
            .font(.subheadline)
            GeometryReader { proxy in
                let width = proxy.size.width * GearStatsPresentation.fraction(year.total, of: maximum)
                HStack(spacing: 1) {
                    ForEach(Array(year.segments.enumerated()), id: \.offset) { _, segment in
                        Rectangle()
                            .fill(YearPalette.color(segment.cameraIndex))
                            .frame(width: max(0, width * GearStatsPresentation.fraction(segment.count, of: year.total) - 1))
                    }
                }
                .clipShape(Capsule())
            }
            .frame(height: 10)
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(year.accessibilityLabel)
    }
}
