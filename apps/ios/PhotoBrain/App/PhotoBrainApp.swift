import SwiftUI

@main
struct PhotoBrainApp: App {
    @UIApplicationDelegateAdaptor(PhotoBrainAppDelegate.self) private var appDelegate
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
    @Published private(set) var onThisDay: OnThisDayStore?
    @Published private(set) var search: SearchStore?
    @Published private(set) var collections: CollectionsStore?
    @Published private(set) var smartAlbums: SmartAlbumsStore?
    @Published private(set) var events: EventsStore?
    @Published private(set) var people: PeopleStore?
    @Published private(set) var review: ReviewStore?
    @Published private(set) var duplicates: DuplicatesStore?
    @Published private(set) var scans: ScanCoordinator?
    @Published private(set) var theme: ThemeController?
    @Published private(set) var configurationError: String?

    let links = AppLinkRouter(lane: .current)
    private let preferences = PreferencesStore()
    private var started = false

    func start() async {
        guard !started else { return }
        started = true
        do {
            let environment = try AppEnvironment()
            let theme = ThemeController(preference: await preferences.theme, preferences: preferences)
            let curation = PhotoCurationCenter(api: environment.api)
            let library = LibraryStore(api: environment.api, curation: curation)
            let onThisDay = OnThisDayStore(api: environment.api)
            let search = SearchStore(api: environment.api, curation: curation)
            let collections = CollectionsStore(api: environment.api)
            let smartAlbums = SmartAlbumsStore(api: environment.api)
            let events = EventsStore(api: environment.api)
            let people = PeopleStore(api: environment.api)
            let review = ReviewStore(api: environment.api, curation: curation)
            let duplicates = DuplicatesStore(api: environment.api, curation: curation)
            let scans = ScanCoordinator(api: environment.api, preferences: preferences)
            scans.invalidateLibrary = { [weak library, weak onThisDay, weak review, weak duplicates] in
                await library?.load()
                await onThisDay?.load()
                await review?.refreshCounts()
                await duplicates?.refreshCounts()
            }
            scans.invalidateSearch = { [weak search] in
                guard let search,
                      !search.query.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return }
                search.retry()
            }
            await scans.restore(savedActiveID: await preferences.activeScanID)
            BackupRuntime.shared.coordinator?.onFileCreated = { [weak scans] in scans?.expectImport() }
            self.environment = environment
            self.theme = theme
            self.library = library
            self.onThisDay = onThisDay
            self.search = search
            self.collections = collections
            self.smartAlbums = smartAlbums
            self.events = events
            self.people = people
            self.review = review
            self.duplicates = duplicates
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
           let onThisDay = bootstrap.onThisDay,
           let search = bootstrap.search,
           let collections = bootstrap.collections,
           let smartAlbums = bootstrap.smartAlbums,
           let events = bootstrap.events,
           let people = bootstrap.people,
           let review = bootstrap.review,
           let duplicates = bootstrap.duplicates,
           let scans = bootstrap.scans,
           let theme = bootstrap.theme {
            RootTabView(
                environment: environment,
                library: library,
                onThisDay: onThisDay,
                search: search,
                collections: collections,
                smartAlbums: smartAlbums,
                events: events,
                people: people,
                review: review,
                duplicates: duplicates,
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
    let onThisDay: OnThisDayStore
    @ObservedObject var search: SearchStore
    let collections: CollectionsStore
    let smartAlbums: SmartAlbumsStore
    let events: EventsStore
    let people: PeopleStore
    let review: ReviewStore
    let duplicates: DuplicatesStore
    @ObservedObject var scans: ScanCoordinator
    @ObservedObject var theme: ThemeController
    @ObservedObject var links: AppLinkRouter
    @Environment(\.scenePhase) private var scenePhase
    @State private var navigation = AppLinkNavigationState()

    var body: some View {
        TabView(selection: $navigation.selectedTab) {
            LibraryScreen(
                store: library,
                onThisDay: onThisDay,
                collections: collections,
                smartAlbums: smartAlbums,
                review: review,
                duplicates: duplicates,
                scans: scans,
                environment: environment,
                theme: theme,
                selectedTab: $navigation.selectedTab
            )
            .tabItem { Label("Library", systemImage: "photo.on.rectangle") }
            .tag(AppTab.library)

            CollectionsScreen(
                store: collections,
                smartAlbums: smartAlbums,
                events: events,
                people: people,
                curation: library.curation,
                environment: environment,
                theme: theme
            )
            .tabItem { Label("Collections", systemImage: "rectangle.stack") }
            .tag(AppTab.collections)

            SearchScreen(store: search, api: environment.api, collections: collections, smartAlbums: smartAlbums)
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
        .environment(\.peopleStore, people)
        .environment(\.backupCoordinator, BackupRuntime.shared.coordinator)
        .environment(\.showInLibrary, ShowInLibraryAction { shortcut in
            navigation.selectedTab = .library
            library.show(shortcut)
        })
        .preferredColorScheme(theme.preference.colorScheme)
        .onAppear {
            applyPendingLink()
            BackupRuntime.shared.coordinator?.applicationBecameActive()
        }
        .onChange(of: links.pendingRoute) { _, route in
            guard route != nil else { return }
            applyPendingLink()
        }
        .onChange(of: scenePhase) { _, phase in
            switch phase {
            case .active:
                Task { await scans.applicationBecameActive() }
                Task { await onThisDay.applicationBecameActive() }
                BackupRuntime.shared.coordinator?.applicationBecameActive()
            case .background:
                BackupRuntime.shared.coordinator?.applicationEnteredBackground()
            default:
                break
            }
        }
    }

    private func applyPendingLink() {
        guard let route = links.takePendingRoute() else { return }
        navigation.apply(route)
    }
}
