import XCTest

/// Library, loupe, review, and browse flows against the seeded fixture library.
final class LibraryFlowTests: PhotoBrainUITestCase {
    @MainActor
    func testLibraryGridLabelsCurationPairsAndMotion() {
        openLibrary()
        // 23 rows: the ARW stacks under its JPEG and the Live Photo clip under its still.
        waitFor(element("21 Items"))
        waitFor(gridCell("beach-waves.jpg, 5 stars, Pick"))
        waitFor(gridCell("beach-sunset.jpg, ARW plus JPG pair"))
        waitFor(gridCell("IMG_2001.HEIC, Live Photo"))
        waitFor(gridCell("skate-park.mp4, Video, 12 seconds"))
        XCTAssertFalse(element("IMG_2001.MOV").exists, "Live Photo clip must not be its own cell")
    }

    @MainActor
    func testLoupeRatesPhotoAndShowsTags() async throws {
        openLibrary()
        gridCell("dog-park-1.jpg").tap()
        waitFor(element("Close photo"))

        tap("Rate 3 stars")
        tap("Pick")
        try await waitForPhoto(10) { $0["rating"] as? Int == 3 && $0["flag"] as? String == "pick" }

        tap("Photo info")
        waitFor(navigationTitle("Photo Info"))
        waitFor(element("Tag Dog"))
        tap("Done")
        tap("Close photo")
        waitFor(gridCell("dog-park-1.jpg, 3 stars, Pick"))
    }

    @MainActor
    func testFindSimilarRanksSameSubjectFirst() {
        openLibrary()
        gridCell("dog-park-1.jpg").tap()
        tap("More")
        tap("Find Similar")
        waitFor(navigationTitle("Similar Photos"))
        waitFor(app.staticTexts["Similar to dog-park-1.jpg"])
        // Scoped to the results grid: the loupe's filmstrip stays in the hierarchy under the sheet.
        let results = app.scrollViews["photo-results"].buttons.matching(NSPredicate(format: "label BEGINSWITH 'Open '"))
        waitFor(results.firstMatch)
        XCTAssertEqual(results.firstMatch.label, "Open dog-park-2.jpg")
        tap("Done")
        waitFor(element("Close photo"))
    }

    @MainActor
    func testAddToExistingAndNewCollectionFromLoupe() async throws {
        openLibrary()
        gridCell("beach-waves.jpg, 5 stars, Pick").tap()
        tap("More")
        tap("Add to Collection")
        waitFor(navigationTitle("Add to Collection"))

        let lisbon = waitFor(element("Lisbon Favorites"))
        XCTAssertEqual(lisbon.value as? String, "Not in collection")
        lisbon.tap()
        waitFor(app.descendants(matching: .any).matching(
            NSPredicate(format: "label == 'Lisbon Favorites' AND value == 'In collection'")
        ).firstMatch)

        tap("New Collection…")
        let name = waitFor(app.alerts["New Collection"].textFields.firstMatch)
        name.typeText("Beach Days")
        app.alerts["New Collection"].buttons["Create"].tap()
        tap("Done")

        let collections = try await fixtureJSON("api/v1/collections")["collections"] as? [[String: Any]] ?? []
        let counts = Dictionary(uniqueKeysWithValues: collections.map { ($0["name"] as? String ?? "", $0["photoCount"] as? Int ?? -1) })
        XCTAssertEqual(counts, ["Lisbon Favorites": 4, "Beach Days": 1])
    }

    @MainActor
    func testLivePhotoAndVideoLoupes() {
        openLibrary()
        gridCell("IMG_2001.HEIC, Live Photo").tap()
        waitFor(element("Play Live Photo"))
        tap("Close photo")

        gridCell("skate-park.mp4, Video, 12 seconds").tap()
        tap("Photo info")
        waitFor(navigationTitle("Video Info"))
        tap("Done")
    }

    @MainActor
    func testPlaceRowFiltersLibraryToCity() {
        openLibrary()
        gridCell("lisbon-1.jpg").tap()
        tap("Photo info")
        scrollTo(element("Place, Lisbon, Portugal")).tap()
        waitFor(element(startingWith: "Edit filters, "))
        waitFor(element("6 Items"))
        tap("Clear all filters")
        waitFor(element("21 Items"))
    }

    @MainActor
    func testReviewRejectsAllCandidates() async throws {
        openLibrary()
        openBrowseMenu()
        tap("Review, 4 photos")
        waitFor(navigationTitle("Review"))
        for label in ["All, 4", "Screenshots, 1", "Documents, 1", "Blurry, 1", "Too dark, 1"] {
            waitFor(element(label))
        }
        waitFor(element("settings-screenshot.png, Screenshots"))

        tap("Reject All (4)")
        tap("Reject 4 Photos")
        waitFor(app.staticTexts["Nothing to review"])

        let review = try await fixtureJSON("api/v1/review/junk")
        XCTAssertEqual((review["counts"] as? [String: Int])?["all"], 0)
        let receipt = try await fixtureJSON("api/v1/photos/16")
        XCTAssertEqual(receipt["flag"] as? String, "reject")
    }

    @MainActor
    func testDuplicatesListsGroupsAndDismissesOne() {
        openLibrary()
        waitFor(element("Library options, 4 photos to review, 2 duplicate groups"))
        openBrowseMenu()
        tap("Duplicates, 2 groups")
        waitFor(navigationTitle("Duplicates"))
        waitFor(element("Bursts, 1 group"))
        waitFor(element("Compare 2 photos"))
        waitFor(element("Compare 3 photos"))

        tap("Duplicates, 1 group")
        waitFor(element("dog-park-1.jpg, suggested, keep"))
        app.buttons["Not duplicates"].firstMatch.tap()
        waitFor(app.staticTexts["No duplicates"])
        goBack()
        waitFor(element("Library options, 4 photos to review, 1 duplicate group"))
    }

    @MainActor
    func testCalendarDayFiltersLibrary() {
        openLibrary()
        openBrowseMenu()
        tap("Calendar")
        waitFor(navigationTitle("Calendar"))
        waitFor(app.staticTexts["June 2024"])
        tap("June 1, 2024, 1 photo")
        waitForAbsence(navigationTitle("Calendar"))
        waitFor(element("1 Item"))
        waitFor(gridCell("IMG_2001.HEIC, Live Photo"))
    }

    @MainActor
    func testMapShowsPhotosInVisibleArea() {
        openLibrary()
        openBrowseMenu()
        tap("Map")
        waitFor(navigationTitle("Map"))
        let show = waitFor(app.buttons.matching(NSPredicate(format: "label BEGINSWITH 'Show ' AND label ENDSWITH 'Photos'")).firstMatch)
        waitForEnabled(show)
        // Lisbon (6 photos) and Santa Cruz (2) are farther apart than MapKit can zoom out on a
        // phone, so the map opens on the larger group.
        XCTAssertEqual(show.label, "Show 6 Photos")
        show.tap()
        waitFor(navigationTitle("Photos in This Area"))
    }

    @MainActor
    func testGearStatsCountsCamerasAndLenses() {
        openLibrary()
        openBrowseMenu()
        tap("Gear Stats")
        waitFor(navigationTitle("Gear Stats"))
        waitFor(element("FUJIFILM X-T5: 7 photos"))
        waitFor(element("SONY ILCE-7M4: 5 photos"))
        waitFor(element("XF23mmF1.4 R LM WR: 6 photos"))
        tap("Done")
        waitForAbsence(navigationTitle("Gear Stats"))
    }

    @MainActor
    func testOnThisDayCardFiltersToThatDate() {
        openCollections()
        waitFor(app.staticTexts["Memories"])
        let card = waitFor(element(startingWith: "5 years ago, "))
        XCTAssertTrue(card.label.hasSuffix(", 1 photo"), card.label)
        waitFor(element(startingWith: "8 years ago, "))
        card.tap()
        waitFor(element("1 Item"))
        waitFor(gridCell("on-this-day-5-years.jpg"))
    }

    @MainActor
    func testVideoFilterSavesSmartAlbum() async throws {
        openLibrary()
        openBrowseMenu()
        tap("Library Options")
        waitFor(navigationTitle("Library Options"))
        waitFor(element(startingWith: "Filter")).tap()
        waitFor(navigationTitle("Filter"))
        app.segmentedControls.buttons["Video"].tap()

        tap("Save as Smart Album…")
        replaceText(of: waitFor(app.textFields["Name"]), with: "Clips")
        tap("Save")
        goBack()
        tap("Done")

        waitFor(element("Edit filters, Video"))
        waitFor(element("1 Item"))
        waitFor(gridCell("skate-park.mp4, Video, 12 seconds"))

        let albums = try await fixtureJSON("api/v1/smart-albums")["albums"] as? [[String: Any]] ?? []
        let clips = try XCTUnwrap(albums.first { $0["name"] as? String == "Clips" })
        XCTAssertEqual((clips["filters"] as? [String: String])?["filterRaw"], "video")
    }

    /// Polls the fixture until photo `id` satisfies `predicate`; curation saves are optimistic.
    private func waitForPhoto(
        _ id: Int,
        file: StaticString = #filePath,
        line: UInt = #line,
        _ predicate: ([String: Any]) -> Bool
    ) async throws {
        for _ in 0..<20 {
            if predicate(try await fixtureJSON("api/v1/photos/\(id)")) { return }
            try await Task.sleep(for: .milliseconds(250))
        }
        XCTFail("Photo \(id) never reached the expected state", file: file, line: line)
    }
}
