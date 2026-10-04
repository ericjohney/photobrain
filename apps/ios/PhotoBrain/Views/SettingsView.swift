import SwiftUI

struct SettingsView: View {
    let environment: AppEnvironment
    @ObservedObject var theme: ThemeController
    @Environment(\.backupCoordinator) private var backup

    var body: some View {
        Form {
            Section("Appearance") {
                Picker("Theme", selection: themeBinding) {
                    ForEach(ThemePreference.allCases) { preference in
                        Text(preference.title).tag(preference)
                    }
                }
                .pickerStyle(.segmented)
                .accessibilityLabel("Theme")
            }

            Section("Library") {
                LabeledContent("Grid Size", value: "Automatic (5–8 columns)")
                    .foregroundStyle(.secondary)
                    .disabled(true)
                    .accessibilityHint("Grid size customization is not available")
                Toggle("Haptic Feedback", isOn: .constant(true))
                    .disabled(true)
                    .accessibilityHint("Uses the system default and cannot be changed")
            }

            if let backup {
                BackupSettingsSection(backup: backup)
            }

            Section("PhotoBrain") {
                LabeledContent("Server", value: environment.apiURL.host ?? environment.apiURL.absoluteString)
                LabeledContent("API", value: "v1")
                LabeledContent("Build", value: AppBuildInfo.versionAndBuild)
                LabeledContent("Environment", value: environment.lane.rawValue)
                NavigationLink("About PhotoBrain") {
                    AboutView()
                }
            }

            Section {
                Link("Open API Server", destination: environment.apiURL)
            } footer: {
                Text("PhotoBrain connects to your self-hosted library. Photos remain on the configured server.")
            }
        }
        .navigationTitle("Settings")
    }

    private var themeBinding: Binding<ThemePreference> {
        Binding(get: { theme.preference }, set: { theme.select($0) })
    }
}

struct AboutView: View {
    var body: some View {
        List {
            Section {
                VStack(spacing: 10) {
                    Image(systemName: "photo.on.rectangle.angled")
                        .font(.system(size: 54))
                        .foregroundStyle(.tint)
                        .accessibilityHidden(true)
                    Text("PhotoBrain")
                        .font(.largeTitle.bold())
                    Text("Version \(AppBuildInfo.versionAndBuild)")
                        .foregroundStyle(.secondary)
                }
                .frame(maxWidth: .infinity)
                .padding(.vertical, 20)
                .accessibilityElement(children: .combine)
            }
            Section("About") {
                Text("PhotoBrain is a fast, intelligent, self-hosted photo library. It keeps originals on your configured server while offering native browsing and semantic search.")
            }
            Section("Technology") {
                Label("Native SwiftUI interface", systemImage: "swift")
                Label("AI-powered semantic search", systemImage: "sparkles")
                Label("Hono backend API", systemImage: "server.rack")
                Label("SQLite database", systemImage: "cylinder")
                Label("Rust image processing", systemImage: "bolt")
            }
            Section("Features") {
                Label("Responsive photo grid", systemImage: "checkmark.circle")
                Label("Automatic EXIF metadata", systemImage: "checkmark.circle")
                Label("RAW photo previews", systemImage: "checkmark.circle")
                Label("Durable scan recovery", systemImage: "checkmark.circle")
            }
        }
        .navigationTitle("About")
        .navigationBarTitleDisplayMode(.inline)
    }
}

enum AppBuildInfo {
    static var version: String {
        Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "—"
    }

    static var build: String {
        Bundle.main.object(forInfoDictionaryKey: "CFBundleVersion") as? String ?? "—"
    }

    static var versionAndBuild: String {
        "\(version) (\(build))"
    }
}
