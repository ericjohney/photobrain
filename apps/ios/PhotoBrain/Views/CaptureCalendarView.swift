import SwiftUI

/// Library Calendar sheet: one month of EXIF capture-day counts at a time. Tapping a day with
/// photos dismisses the sheet and hands its `yyyy-MM-dd` value to `select`, which applies the
/// Library's `capturedDate` filter.
struct CaptureCalendarView: View {
    let calendar: CaptureCalendar
    /// The active `capturedDate` filter, highlighted when visible.
    let capturedDate: String?
    let select: (String) -> Void

    @Environment(\.dismiss) private var dismiss
    @Environment(\.calendar) private var deviceCalendar
    @Environment(\.locale) private var locale
    @State private var month: CaptureCalendar.Month?

    private let columns = Array(repeating: GridItem(.flexible(), spacing: 4), count: 7)

    init(calendar: CaptureCalendar, capturedDate: String?, select: @escaping (String) -> Void) {
        self.calendar = calendar
        self.capturedDate = capturedDate
        self.select = select
        _month = State(initialValue: calendar.initialMonth(capturedDate: capturedDate))
    }

    var body: some View {
        NavigationStack {
            Group {
                if let month {
                    ScrollView {
                        VStack(spacing: 12) {
                            monthHeader(month)
                            weekdayHeader
                            LazyVGrid(columns: columns, spacing: 4) {
                                ForEach(calendar.cells(for: month, firstWeekday: deviceCalendar.firstWeekday)) { cell in
                                    switch cell {
                                    case .blank:
                                        Color.clear
                                            .frame(minHeight: 48)
                                            .accessibilityHidden(true)
                                    case let .day(day, count):
                                        dayCell(day, count: count)
                                    }
                                }
                            }
                        }
                        .padding()
                    }
                } else {
                    ContentUnavailableView(
                        "No Capture Dates",
                        systemImage: "calendar",
                        description: Text("Photos with a camera capture date appear here.")
                    )
                }
            }
            .navigationTitle("Calendar")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") { dismiss() }
                }
            }
        }
    }

    private func monthHeader(_ month: CaptureCalendar.Month) -> some View {
        let previous = calendar.previousMonth(before: month)
        let next = calendar.nextMonth(after: month)
        return HStack {
            Button {
                self.month = previous
            } label: {
                Image(systemName: "chevron.left")
                    .frame(width: 44, height: 44)
            }
            .disabled(previous == nil)
            .accessibilityLabel("Previous month")
            .accessibilityValue(previous.map { CaptureCalendar.title(for: $0, locale: locale) } ?? "")

            Spacer()
            Text(CaptureCalendar.title(for: month, locale: locale))
                .font(.title3.weight(.semibold))
                .accessibilityAddTraits(.isHeader)
            Spacer()

            Button {
                self.month = next
            } label: {
                Image(systemName: "chevron.right")
                    .frame(width: 44, height: 44)
            }
            .disabled(next == nil)
            .accessibilityLabel("Next month")
            .accessibilityValue(next.map { CaptureCalendar.title(for: $0, locale: locale) } ?? "")
        }
        .font(.title3)
    }

    private var weekdayHeader: some View {
        let firstWeekday = deviceCalendar.firstWeekday
        let short = CaptureCalendar.orderedWeekdaySymbols(deviceCalendar.veryShortStandaloneWeekdaySymbols, firstWeekday: firstWeekday)
        let full = CaptureCalendar.orderedWeekdaySymbols(deviceCalendar.standaloneWeekdaySymbols, firstWeekday: firstWeekday)
        return LazyVGrid(columns: columns, spacing: 4) {
            ForEach(short.indices, id: \.self) { index in
                Text(short[index])
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(.secondary)
                    .frame(maxWidth: .infinity)
                    .accessibilityLabel(index < full.count ? full[index] : short[index])
            }
        }
    }

    private func dayCell(_ day: CaptureCalendar.Day, count: Int) -> some View {
        let isSelected = day.capturedDate == capturedDate
        return Button {
            guard let value = calendar.capturedDate(selecting: day) else { return }
            dismiss()
            select(value)
        } label: {
            VStack(spacing: 2) {
                Text(day.day.formatted())
                    .font(.body.monospacedDigit())
                    .fontWeight(isSelected ? .bold : .regular)
                if count > 0 {
                    Text(count.formatted())
                        .font(.caption2.weight(.semibold).monospacedDigit())
                        .foregroundStyle(.white)
                        .padding(.horizontal, 5)
                        .padding(.vertical, 1)
                        .background(Capsule().fill(Color.accentColor))
                        .lineLimit(1)
                        .minimumScaleFactor(0.6)
                } else {
                    Text(" ")
                        .font(.caption2)
                        .padding(.vertical, 1)
                }
            }
            .frame(maxWidth: .infinity, minHeight: 48)
            .background {
                if isSelected {
                    RoundedRectangle(cornerRadius: 8).strokeBorder(Color.accentColor, lineWidth: 2)
                }
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .foregroundStyle(count > 0 ? Color.primary : Color.secondary.opacity(0.5))
        .disabled(count == 0)
        .accessibilityLabel(CaptureCalendar.accessibilityLabel(for: day, count: count, locale: locale))
        .accessibilityAddTraits(isSelected ? .isSelected : [])
    }
}
