import XCTest

/// Collections tab, Search tab, and Settings flows against the seeded fixture library.
final class CollectionsSearchFlowTests: PhotoBrainUITestCase {
    @MainActor
    func testCollectionsShowsSeededSectionsAndOpensDetails() {
        openCollections()
        waitFor(app.staticTexts["Memories"])

        tap("Lisbon Favorites, 3 photos")
        waitFor(navigationTitle("Lisbon Favorites"))
        waitFor(gridCell("lisbon-1.jpg"))
        XCTAssertFalse(element("lisbon-4.jpg").exists)
        goBack()

        let event = waitFor(element(startingWith: "Lisbon, Portugal, "))
        XCTAssertTrue(event.label.hasSuffix("6 photos"), event.label)
        event.tap()
        waitFor(navigationTitle("Lisbon, Portugal"))
        waitFor(gridCell("lisbon-6.jpg"))
        goBack()

        tap("Sony Shots, smart album, 5 photos")
        waitFor(navigationTitle("Sony Shots"))
        waitFor(gridCell("burst-1.jpg"))
    }

    @MainActor
    func testCreateCollectionFromToolbar() async throws {
        openCollections()
        tap("New Collection")
        let alert = app.alerts["New Collection"]
        waitFor(alert.textFields.firstMatch).typeText("Road Trip")
        alert.buttons["Create"].tap()
        waitFor(element("Road Trip, 0 photos"))

        let collections = try await fixtureJSON("api/v1/collections")["collections"] as? [[String: Any]] ?? []
        XCTAssertEqual(Set(collections.compactMap { $0["name"] as? String }), ["Lisbon Favorites", "Road Trip"])
    }

    @MainActor
    func testSemanticSearchOpensResultAndSavesAlbum() async throws {
        app.tabBars.buttons["Search"].tap()
        waitFor(element("Search your library"))
        XCTAssertFalse(app.buttons["Save as Smart Album"].isEnabled)

        let field = waitFor(app.searchFields["Describe a photo"])
        field.tap()
        field.typeText("dog\n")
        let results = app.buttons.matching(NSPredicate(format: "label BEGINSWITH 'Open '"))
        waitFor(results.firstMatch)
        XCTAssertTrue(results.firstMatch.label.hasPrefix("Open dog-park-"), results.firstMatch.label)

        results.firstMatch.tap()
        waitFor(element("Close photo"))
        tap("Close photo")

        // While the search field is active the toolbar is hidden; the filter bar's Filters sheet
        // carries the query into Save as Smart Album.
        tap("Add filters")
        waitFor(navigationTitle("Filter"))
        tap("Save as Smart Album…")
        replaceText(of: waitFor(app.textFields["Name"]), with: "Dogs")
        tap("Save")
        // The sheet dismisses only after the server accepts the album.
        waitForAbsence(navigationTitle("Save as Smart Album"))

        let albums = try await fixtureJSON("api/v1/smart-albums")["albums"] as? [[String: Any]] ?? []
        let dogs = try XCTUnwrap(albums.first { $0["name"] as? String == "Dogs" })
        XCTAssertEqual(dogs["query"] as? String, "dog")
    }

    @MainActor
    func testSettingsReportsFixtureServerAndDebugLane() {
        openCollections()
        tap("Settings")
        waitFor(navigationTitle("Settings"))
        scrollTo(element("Server, \(fixtureURL.host ?? "")"))
        scrollTo(element("API, v1"))
        scrollTo(element("Environment, Debug"))
    }
}
