import SwiftUI
import UIKit

/// Settings → Backup: camera-roll backup switches, device name, status, and Back Up Now.
struct BackupSettingsSection: View {
    @ObservedObject var backup: BackupCoordinator
    @State private var deviceName = ""
    @State private var isEnabling = false
    @FocusState private var deviceNameFocused: Bool

    var body: some View {
        Section {
            Toggle("Back Up Camera Roll", isOn: enabledBinding)
                .disabled(isEnabling)
            Toggle("Include Videos", isOn: Binding(
                get: { backup.settings.includeVideos },
                set: { backup.setIncludeVideos($0) }
            ))
            Toggle("Allow Cellular", isOn: Binding(
                get: { backup.settings.allowCellular },
                set: { backup.setAllowCellular($0) }
            ))
            LabeledContent("Device Name") {
                TextField("iPhone", text: $deviceName)
                    .multilineTextAlignment(.trailing)
                    .textInputAutocapitalization(.words)
                    .autocorrectionDisabled()
                    .submitLabel(.done)
                    .focused($deviceNameFocused)
                    .onSubmit(commitDeviceName)
                    .accessibilityLabel("Device Name")
            }
            permissionNotice
            if backup.settings.enabled && backup.authorization.canRead {
                status
                Button("Back Up Now") { backup.backUpNow() }
                    .disabled(backup.activity != .idle && !backup.serverDisabled)
            }
        } header: {
            Text("Backup")
        } footer: {
            Text("Originals upload to Uploads/\(backup.settings.deviceName) on your server and appear in the library after the next scan.")
        }
        .onAppear { deviceName = backup.settings.deviceName }
        .onChange(of: deviceNameFocused) { _, focused in
            if !focused { commitDeviceName() }
        }
    }

    private var enabledBinding: Binding<Bool> {
        Binding(
            get: { backup.settings.enabled },
            set: { enabled in
                isEnabling = true
                Task {
                    await backup.setEnabled(enabled)
                    isEnabling = false
                }
            }
        )
    }

    @ViewBuilder
    private var permissionNotice: some View {
        switch backup.authorization {
        case .denied, .restricted:
            VStack(alignment: .leading, spacing: 6) {
                Label("PhotoBrain can’t read your photos.", systemImage: "exclamationmark.triangle")
                    .foregroundStyle(.orange)
                Text(backup.authorization == .restricted
                    ? "Photos access is restricted on this device."
                    : "Allow Photos access in Settings to back up your camera roll.")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                settingsLink
            }
        case .limited:
            VStack(alignment: .leading, spacing: 6) {
                Text("Only the photos you selected are backed up. Allow access to all photos in Settings to back up your whole camera roll.")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                settingsLink
            }
        case .notDetermined, .authorized:
            EmptyView()
        }
    }

    @ViewBuilder
    private var settingsLink: some View {
        if let url = URL(string: UIApplication.openSettingsURLString) {
            Link("Open Settings", destination: url)
                .font(.footnote)
        }
    }

    @ViewBuilder
    private var status: some View {
        if backup.serverDisabled {
            Label("Uploads are disabled on the server", systemImage: "icloud.slash")
                .foregroundStyle(.secondary)
        } else {
            if backup.hasPlanned {
                LabeledContent("Backed Up", value: "\(backup.backedUpAssets) of \(backup.totalAssets)")
            } else if backup.activity != .idle {
                LabeledContent("Status", value: activityText)
            }
            ForEach(backup.uploads) { upload in
                VStack(alignment: .leading, spacing: 4) {
                    Text("Uploading \(upload.filename)")
                        .font(.footnote)
                        .lineLimit(1)
                        .truncationMode(.middle)
                    ProgressView(value: upload.fraction)
                }
                .accessibilityElement(children: .combine)
                .accessibilityValue("\(Int(upload.fraction * 100)) percent")
            }
            if backup.uploads.isEmpty, backup.hasPlanned, backup.activity != .idle, backup.activity != .uploading {
                LabeledContent("Status", value: activityText)
            }
        }
        if backup.failedFiles > 0 || backup.lastError != nil {
            VStack(alignment: .leading, spacing: 4) {
                if backup.failedFiles > 0 {
                    Text("\(backup.failedFiles) failed")
                        .foregroundStyle(.red)
                }
                if let error = backup.lastError {
                    Text(error)
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                }
            }
            .accessibilityElement(children: .combine)
        }
    }

    private var activityText: String {
        switch backup.activity {
        case .idle: "Idle"
        case .checkingServer: "Contacting server…"
        case .scanningLibrary: "Scanning camera roll…"
        case .reconciling: "Checking earlier uploads…"
        case .uploading: "Preparing uploads…"
        }
    }

    private func commitDeviceName() {
        backup.setDeviceName(deviceName)
        deviceName = backup.settings.deviceName
    }
}
