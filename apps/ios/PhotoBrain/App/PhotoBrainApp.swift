import SwiftUI

@main
struct PhotoBrainApp: App {
    @StateObject private var bootstrap = AppBootstrap()

    var body: some Scene {
        WindowGroup {
            BootstrapView(bootstrap: bootstrap)
                .task { await bootstrap.start() }
                .onOpenURL { bootstrap.links.open($0) }
        }
    }
}

@MainActor
final class AppBootstrap: ObservableObject {
    @Published private(set) var environment: AppEnvironment?
    @Published private(set) var library: LibraryStore?
    @Published private(set) var search: SearchStore?
    @Published private(set) var collections: CollectionsStore?
    @Published private(set) var scans: ScanCoordinator?
    @Published private(set) var theme: ThemeController?
    @Published private(set) var configurationError: String?

    let links = AppLinkRouter(lane: .current)
    private let migration = MigrationStore()
    private var started = false

    func start() async {
        guard !started else { return }
        started = true
        do {
            let environment = try AppEnvironment()
            let imported = await migration.importSchemaOne()
            let theme = ThemeController(preference: imported.theme, migration: migration)
            let curation = PhotoCurationCenter(api: environment.api)
            let library = LibraryStore(api: environment.api, curation: curation)
            let search = SearchStore(api: environment.api, curation: curation)
            let collections = CollectionsStore(api: environment.api)
            let scans = ScanCoordinator(api: environment.api, migration: migration)
            scans.invalidateLibrary = { [weak library] in
                await library?.load()
            }
            scans.invalidateSearch = { [weak search] in
                guard let search,
                      !search.query.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return }
                search.retry()
            }
            await scans.restore(importedActiveID: imported.activeScanID)
            self.environment = environment
            self.theme = theme
            self.library = library
            self.search = search
            self.collections = collections
            self.scans = scans
        } catch {
            configurationError = (error as? LocalizedError)?.errorDescription ?? error.localizedDescription
        }
    }
}

private struct BootstrapView: View {
    @ObservedObject var bootstrap: AppBootstrap

    var body: some View {
        if let environment = bootstrap.environment,
           let library = bootstrap.library,
           let search = bootstrap.search,
           let collections = bootstrap.collections,
           let scans = bootstrap.scans,
           let theme = bootstrap.theme {
            RootTabView(
                environment: environment,
                library: library,
                search: search,
                collections: collections,
                scans: scans,
                theme: theme,
                links: bootstrap.links
            )
        } else if let error = bootstrap.configurationError {
            ContentUnavailableView {
                Label("Configuration Error", systemImage: "exclamationmark.triangle")
            } description: {
                Text(error)
            }
        } else {
            ProgressView("Starting PhotoBrain…")
        }
    }
}

private struct RootTabView: View {
    let environment: AppEnvironment
    @ObservedObject var library: LibraryStore
    @ObservedObject var search: SearchStore
    let collections: CollectionsStore
    @ObservedObject var scans: ScanCoordinator
    @ObservedObject var theme: ThemeController
    @ObservedObject var links: AppLinkRouter
    @Environment(\.scenePhase) private var scenePhase
    @State private var navigation = AppLinkNavigationState()

    var body: some View {
        TabView(selection: $navigation.selectedTab) {
            LibraryScreen(
                store: library,
                collections: collections,
                scans: scans,
                environment: environment,
                theme: theme,
                selectedTab: $navigation.selectedTab
            )
            .tabItem { Label("Library", systemImage: "photo.on.rectangle") }
            .tag(AppTab.library)

            CollectionsScreen(
                store: collections,
                curation: library.curation,
                environment: environment,
                theme: theme
            )
            .tabItem { Label("Collections", systemImage: "rectangle.stack") }
            .tag(AppTab.collections)

            SearchScreen(store: search, api: environment.api, collections: collections)
                .tabItem { Label("Search", systemImage: "magnifyingglass") }
                .tag(AppTab.search)
        }
        .sheet(item: $navigation.presentedRoute) { route in
            NavigationStack {
                Group {
                    switch route {
                    case .settings:
                        SettingsView(environment: environment, theme: theme)
                    case .about:
                        AboutView()
                    }
                }
                .toolbar {
                    ToolbarItem(placement: .confirmationAction) {
                        Button("Done") { navigation.presentedRoute = nil }
                    }
                }
            }
        }
        .preferredColorScheme(theme.preference.colorScheme)
        .onAppear { applyPendingLink() }
        .onChange(of: links.pendingRoute) { _, route in
            guard route != nil else { return }
            applyPendingLink()
        }
        .onChange(of: scenePhase) { _, phase in
            guard phase == .active else { return }
            Task { await scans.applicationBecameActive() }
        }
    }

    private func applyPendingLink() {
        guard let route = links.takePendingRoute() else { return }
        navigation.apply(route)
    }
}
