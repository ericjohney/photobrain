import UIKit
import XCTest

/// Library, loupe, review, and browse flows against the seeded fixture library.
final class LibraryFlowTests: PhotoBrainUITestCase {
    @MainActor
    func testRawEditorSavesReopensComparesAndDiscards() {
        openLibrary()
        gridCell("beach-sunset.jpg, ARW plus JPG pair").tap()
        tap("More")
        tap("Edit RAW")
        let slider = app.sliders["raw-edit-exposure"]
        waitFor(slider, timeout: 30)
        slider.adjust(toNormalizedSliderPosition: 0.65)
        let value = app.staticTexts["raw-edit-value"]
        XCTAssertFalse(value.label.contains("+0.00"))
        let savedValue = value.label
        let screenshot = XCTAttachment(screenshot: app.screenshot())
        screenshot.name = "Saved RAW adjustments editor"
        screenshot.lifetime = .keepAlways
        add(screenshot)
        tap("Before / After")
        waitFor(element("Before"))
        tap("Before")
        tap("Save")
        waitForAbsence(slider)
        tap("More")
        tap("Edit RAW")
        waitFor(slider, timeout: 30)
        XCTAssertEqual(value.label, savedValue)
        tap("Reset")
        XCTAssertEqual(value.label, "+0.00 EV")
        tap("Cancel")
        tap("Discard Changes")
        waitForAbsence(slider)
        tap("More")
        tap("Edit RAW")
        waitFor(slider, timeout: 30)
        XCTAssertEqual(value.label, savedValue)
        tap("Cancel")
        waitFor(element("Share"))
        tap("Close photo")
        waitFor(gridCell("beach-sunset.jpg, ARW plus JPG pair"))
    }

    @MainActor
    func testSmartPreviewWorksOfflineAfterRestartAndSyncsOnReconnect() async throws {
        guard ProcessInfo.processInfo.environment["PHOTOBRAIN_SMART_PREVIEW_UI_TEST"] == "1" else {
            throw XCTSkip("Run with UI_TEST_SMART_PREVIEWS=1 TEST_RUNNER_PHOTOBRAIN_SMART_PREVIEW_UI_TEST=1")
        }
        func offline(_ enabled: Bool) async throws {
            var request = URLRequest(url: URL(string: fixtureURL.absoluteString + "/__fixture/offline?enabled=\(enabled ? 1 : 0)")!)
            request.httpMethod = "POST"
            let (_, response) = try await URLSession.shared.data(for: request)
            XCTAssertEqual((response as? HTTPURLResponse)?.statusCode, 200)
        }
        openLibrary()
        gridCell("beach-sunset.jpg, ARW plus JPG pair").tap()
        tap("More"); tap("Edit RAW")
        let slider = app.sliders["raw-edit-exposure"]
        waitFor(slider, timeout: 30)
        let status = app.staticTexts["raw-edit-storage-status"]
        waitFor(status)
        XCTAssertEqual(status.label, "Available offline")
        try await offline(true)
        slider.adjust(toNormalizedSliderPosition: 0.68)
        let value = app.staticTexts["raw-edit-value"].label
        XCTAssertFalse(value.contains("+0.00"))
        // Wait for the real Rust render and atomic draft journal, then kill the app.
        let updating = element("Updating preview…")
        waitForAbsence(updating)
        try await Task.sleep(for: .milliseconds(250))
        app.terminate()
        app.launchEnvironment.removeValue(forKey: "PHOTOBRAIN_CLEAR_SMART_PREVIEWS")
        app.launch()
        openLibrary()
        gridCell("beach-sunset.jpg, ARW plus JPG pair").tap()
        tap("More"); tap("Edit RAW")
        waitFor(slider, timeout: 30)
        XCTAssertEqual(app.staticTexts["raw-edit-value"].label, value)
        slider.adjust(toNormalizedSliderPosition: 0.72)
        let savedValue = app.staticTexts["raw-edit-value"].label
        tap("Save")
        let queued = XCTNSPredicateExpectation(predicate: NSPredicate(format: "label CONTAINS %@", "Saved on device"), object: status)
        XCTAssertEqual(XCTWaiter.wait(for: [queued], timeout: 10), .completed)
        let attachment = XCTAttachment(screenshot: app.screenshot())
        attachment.name = "Smart preview edited offline after restart"
        attachment.lifetime = .keepAlways; add(attachment)
        try await offline(false)
        tap("Save")
        waitForAbsence(slider, timeout: 30)
        tap("More"); tap("Edit RAW")
        waitFor(slider, timeout: 30)
        XCTAssertEqual(app.staticTexts["raw-edit-value"].label, savedValue)
        tap("Cancel")
    }

    @MainActor
    func testSharesFullResolutionDevelopedPhoto() {
        openLibrary()
        gridCell("beach-sunset.jpg, ARW plus JPG pair").tap()
        tap("Share")
        tap("Share Developed Photo")
        waitFor(app.otherElements["ActivityListView"], timeout: 30)
    }

    @MainActor
    func testIPadKeepsNavigationAndGroupingAvailableWhileBrowsing() throws {
        guard UIDevice.current.userInterfaceIdiom == .pad else { throw XCTSkip("iPad layout") }
        openLibrary()
        tap("Years")
        waitFor(element(startingWith: "2024"))
        tap("All")
        app.collectionViews.firstMatch.swipeDown()
        XCTAssertTrue(app.buttons["Collections"].firstMatch.isHittable)
        XCTAssertTrue(element("Years").isHittable)
        if app.buttons["Toggle sidebar"].exists {
            app.buttons["Toggle sidebar"].tap()
            XCTAssertTrue(waitFor(element("Collections")).isHittable)
        }
        openCollections()
        tap("Settings")
        waitFor(navigationTitle("Settings"))
        goBack()
        openLibrary()
        waitFor(gridCell("beach-waves.jpg, 5 stars, Pick"))
    }

    @MainActor
    func testIPadSharesPhotoFromLoupe() throws {
        guard UIDevice.current.userInterfaceIdiom == .pad else { throw XCTSkip("iPad share popover") }
        openLibrary()
        gridCell("dog-park-1.jpg").tap()
        tap("Share")
        tap("Share Original")
        waitFor(app.otherElements["ActivityListView"], timeout: 30)
        let screenshot = XCTAttachment(screenshot: app.screenshot())
        screenshot.name = "iPad share popover"
        screenshot.lifetime = .keepAlways
        add(screenshot)
        // iPadOS 26 hosts the actions remotely without exposing them to XCTest.
        // Dismiss the centered popover by tapping the unobscured backdrop.
        app.coordinate(withNormalizedOffset: CGVector(dx: 0.05, dy: 0.2)).tap()
        waitFor(element("Close photo"))
        tap("Close photo")
        waitFor(gridCell("dog-park-1.jpg"))
    }

    @MainActor
    func testRotationPreservesOpenPhotoAndMetadata() {
        openLibrary()
        gridCell("dog-park-1.jpg").tap()
        waitFor(element("Close photo"))
        XCUIDevice.shared.orientation = .landscapeLeft
        XCTAssertTrue(waitFor(app.cells["Open dog-park-1.jpg"].firstMatch).isSelected)
        tap("Photo info")
        waitFor(navigationTitle("Photo Info"))
        waitFor(element("Tag Dog"))
        tap("Done")
        XCUIDevice.shared.orientation = .portrait
        tap("Close photo")
        waitFor(gridCell("dog-park-1.jpg"))
    }

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

        tap("More")
        tap("Rating")
        tap("Rate 3 stars")
        tap("Pick")
        try await waitForPhoto(10) { $0["rating"] as? Int == 3 && $0["flag"] as? String == "pick" }

        tap("Photo info")
        waitFor(navigationTitle("Photo Info"))
        waitFor(element("Tag Dog"))
        tap("Rate 4 stars")
        try await waitForPhoto(10) { $0["rating"] as? Int == 4 }
        tap("Done")
        tap("Close photo")
        waitFor(gridCell("dog-park-1.jpg, 4 stars, Pick"))
    }

    @MainActor
    func testLoupeZoomCoversFilmstripAndRestoresControlsAtFit() {
        openLibrary()
        gridCell("dog-park-1.jpg").tap()
        waitFor(element("Close photo"))
        let thumbnail = app.cells["Open dog-park-1.jpg"].firstMatch
        XCTAssertTrue(waitFor(thumbnail).isHittable)
        let center = app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5))
        center.doubleTap()
        waitForAbsence(element("Close photo"))
        XCTAssertFalse(thumbnail.exists, "The filmstrip must yield to the enlarged image")
        // Photos lets a tap reveal the toolbars over the magnified image, but the
        // filmstrip stays covered so it cannot intercept panning near the bottom.
        center.tap()
        waitFor(element("Close photo"))
        XCTAssertFalse(thumbnail.exists)
        center.doubleTap()
        waitFor(element("Close photo"))
        XCTAssertTrue(waitFor(thumbnail).isHittable)
    }

    @MainActor
    func testLoupeSwipesUpForInfoAndDownToClose() {
        openLibrary()
        gridCell("dog-park-1.jpg").tap()
        waitFor(element("Close photo"))
        let center = app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5))
        center.press(forDuration: 0.05, thenDragTo: app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.15)))
        waitFor(navigationTitle("Photo Info"))
        tap("Done")
        waitForAbsence(navigationTitle("Photo Info"))
        center.press(forDuration: 0.05, thenDragTo: app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.9)))
        waitForAbsence(element("Close photo"))
        waitFor(app.staticTexts["library-title"])
    }

    @MainActor
    func testGroupingControlAndPinchChangeGrid() {
        openLibrary()
        waitFor(gridCell("beach-waves.jpg, 5 stars, Pick"))
        let cell = gridCell("beach-waves.jpg, 5 stars, Pick")
        let wide = cell.frame.width
        pinchGrid(scale: 0.4, velocity: -1)
        XCTAssertLessThan(gridCell("beach-waves.jpg, 5 stars, Pick").frame.width, wide * 0.8)
        // Pinching out restores the wide grid, tall enough to scroll back in time.
        pinchGrid(scale: 3, velocity: 1)
        XCTAssertEqual(gridCell("beach-waves.jpg, 5 stars, Pick").frame.width, wide, accuracy: 1)

        // Scrolling back in time swaps the tab bar for Photos' Years · Months · All switcher.
        app.collectionViews.firstMatch.swipeDown()
        tap("Years")
        let years = app.collectionViews.cells.matching(NSPredicate(format: "label MATCHES %@", "[0-9]{4}"))
        waitFor(years.firstMatch)
        let year = years.allElementsBoundByIndex.first { $0.frame.minY > 100 && $0.frame.maxY < 750 } ?? years.firstMatch
        XCTAssertGreaterThan(year.frame.width, wide * 2, "Years shows a cover card")
        XCTAssertTrue(element("Months").isHittable, "Grouping stays available even when cards fit on screen")
        year.tap()
        XCTAssertTrue(waitFor(element("Months")).isSelected)
        let day = app.collectionViews.cells.allElementsBoundByIndex.first {
            $0.frame.minY > 100 && $0.frame.maxY < 750
        } ?? app.collectionViews.cells.firstMatch
        XCTAssertGreaterThan(waitFor(day).frame.width, wide, "Months shows grouped covers larger than All thumbnails")
        day.tap()
        XCTAssertTrue(waitFor(element("All")).isSelected)
        XCTAssertFalse(element("Close photo").exists, "A cover drills into time instead of opening the loupe")
        app.buttons["Library"].firstMatch.tap()
        waitFor(app.buttons["Collections"].firstMatch)
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
        waitFor(navigationTitle("Search"))
        waitFor(element(startingWith: "Remove filter Lisbon"))
        waitFor(app.staticTexts.matching(NSPredicate(format: "label ENDSWITH '· 6 photos'")).firstMatch)
    }

    @MainActor
    func testReviewRejectsAllCandidates() async throws {
        openCollections()
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
        openCollections()
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
        openCollections()
        waitFor(element("Duplicates, 1 group"))
    }

    @MainActor
    func testCalendarDayFiltersSearch() {
        openCollections()
        tap("Calendar")
        waitFor(navigationTitle("Calendar"))
        waitFor(app.staticTexts["June 2024"])
        tap("June 1, 2024, 1 photo")
        waitForAbsence(navigationTitle("Calendar"))
        waitFor(navigationTitle("Search"))
        waitFor(element(startingWith: "Open IMG_2001.HEIC"))
    }

    @MainActor
    func testMapShowsPhotosInVisibleArea() {
        openCollections()
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
        openCollections()
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
        waitFor(navigationTitle("Search"))
        waitFor(element(startingWith: "Open on-this-day-5-years.jpg"))
    }

    @MainActor
    func testFilterMenuReplacesFilterAndCapsuleClears() {
        openLibrary()
        waitFor(element("21 Items"))
        openBrowseMenu()
        tap("Filter")
        tap("Videos")
        waitFor(element("Clear all filters"))
        waitFor(element("1 Item"))
        waitFor(gridCell("skate-park.mp4, Video, 12 seconds"))

        openBrowseMenu()
        tap("Filter: Videos")
        tap("Picks")
        waitFor(gridCell("beach-waves.jpg, 5 stars, Pick"))
        XCTAssertFalse(element(startingWith: "skate-park.mp4").exists, "Filters replace, never stack")

        tap("Clear all filters")
        waitFor(element("21 Items"))
    }

    @MainActor
    func testSearchVideoFilterSavesSmartAlbum() async throws {
        selectTab("Search")
        waitFor(element("Search your library"))
        tap("Add filters")
        waitFor(navigationTitle("Filter"))
        app.segmentedControls.buttons["Video"].tap()

        tap("Save as Smart Album…")
        replaceText(of: waitFor(app.textFields["Name"]), with: "Clips")
        tap("Save")
        waitForAbsence(navigationTitle("Save as Smart Album"))
        tap("Done")
        waitFor(element(startingWith: "Open skate-park.mp4"))

        let albums = try await fixtureJSON("api/v1/smart-albums")["albums"] as? [[String: Any]] ?? []
        let clips = try XCTUnwrap(albums.first { $0["name"] as? String == "Clips" })
        XCTAssertEqual((clips["filters"] as? [String: String])?["filterRaw"], "video")
    }

    /// Pinches the Library grid on a photo well inside the screen. The full-bleed grid spans
    /// the whole screen, so a pinch over the whole grid starts a finger on the floating title
    /// or the tab bar and the grid sees a single touch.
    @MainActor
    private func pinchGrid(scale: CGFloat, velocity: CGFloat, file: StaticString = #filePath, line: UInt = #line) {
        let grid = app.collectionViews.firstMatch
        waitFor(grid, file: file, line: line)
        let bounds = app.windows.firstMatch.frame
        guard let target = grid.cells.allElementsBoundByIndex.first(where: { cell in
            let frame = cell.frame
            return frame.minY > bounds.minY + 180 && frame.maxY < bounds.maxY - 180
                && frame.minX >= bounds.minX && frame.maxX <= bounds.maxX
        }) else {
            XCTFail("No grid photo in the middle of the screen", file: file, line: line)
            return
        }
        // Index-bound elements re-resolve to other cells once the grid relayouts; pin by label.
        grid.cells.matching(NSPredicate(format: "label == %@", target.label)).firstMatch
            .pinch(withScale: scale, velocity: velocity)
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
