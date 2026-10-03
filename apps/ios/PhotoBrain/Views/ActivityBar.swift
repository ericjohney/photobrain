import SwiftUI

struct ActivityBar: View {
    @ObservedObject var coordinator: ScanCoordinator
    @Environment(\.accessibilityReduceTransparency) private var reduceTransparency

    private var isVisible: Bool {
        coordinator.isRestoring
            || coordinator.isActive
            || coordinator.recoveryError != nil
            || coordinator.selectedScan?.isTerminal == true
    }

    var body: some View {
        if isVisible {
            HStack(spacing: 12) {
                if let fraction = coordinator.selectedScan?.fractionCompleted {
                    ProgressView(value: fraction)
                        .progressViewStyle(.circular)
                } else if coordinator.selectedScan?.isFailed == true {
                    Image(systemName: "exclamationmark.triangle.fill")
                        .foregroundStyle(.orange)
                } else if coordinator.selectedScan?.isTerminal == true {
                    Image(systemName: "checkmark.circle.fill")
                        .foregroundStyle(.green)
                } else {
                    ProgressView()
                }
                VStack(alignment: .leading, spacing: 2) {
                    Text(coordinator.activityTitle)
                        .font(.subheadline.weight(.semibold))
                    Text(coordinator.activityDetail)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .lineLimit(2)
                }
                Spacer(minLength: 0)
                if coordinator.recoveryError != nil || coordinator.isStalled {
                    Button("Retry") {
                        Task { await coordinator.retryRecovery() }
                    }
                    .buttonStyle(.bordered)
                }
            }
            .padding(12)
            .background {
                if reduceTransparency {
                    RoundedRectangle(cornerRadius: 16).fill(Color(uiColor: .secondarySystemBackground))
                } else {
                    RoundedRectangle(cornerRadius: 16).fill(.regularMaterial)
                }
            }
            .shadow(color: .black.opacity(0.15), radius: 12, y: 4)
            .padding(.horizontal, 12)
            .accessibilityElement(children: .combine)
            .accessibilityLabel("\(coordinator.activityTitle). \(coordinator.activityDetail)")
        }
    }
}
