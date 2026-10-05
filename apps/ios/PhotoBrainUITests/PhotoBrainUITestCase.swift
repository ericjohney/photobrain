import XCTest

/// Base class for flows against the seeded fixture API (`apps/api/scripts/ui-test-server.ts`).
///
/// `apps/ios/scripts/run-ui-tests.sh` starts that server and passes its origin to the runner as
/// `PHOTOBRAIN_FIXTURE_URL`. Each test restores the seeded library, then launches the Debug app
/// pointed at the fixture through the Debug-only `PHOTOBRAIN_API_URL` launch override.
class PhotoBrainUITestCase: XCTestCase {
    var app: XCUIApplication!
    var fixtureURL: URL!

    override func setUp() async throws {
        continueAfterFailure = false
        guard let raw = ProcessInfo.processInfo.environment["PHOTOBRAIN_FIXTURE_URL"],
              let url = URL(string: raw) else {
            throw XCTSkip("PHOTOBRAIN_FIXTURE_URL is unset; run apps/ios/scripts/run-ui-tests.sh")
        }
        fixtureURL = url
        var reset = URLRequest(url: url.appendingPathComponent("__fixture/reset"))
        reset.httpMethod = "POST"
        let (_, response) = try await URLSession.shared.data(for: reset)
        XCTAssertEqual((response as? HTTPURLResponse)?.statusCode, 200, "Fixture reset failed")
        await MainActor.run {
            app = XCUIApplication()
            app.launchEnvironment["PHOTOBRAIN_API_URL"] = url.absoluteString
            // Labels embed formatted dates and counts; pin the locale they are asserted in.
            app.launchArguments += ["-AppleLanguages", "(en)", "-AppleLocale", "en_US"]
            app.launch()
        }
    }

    /// A fixture API JSON object, for asserting what a UI action persisted.
    func fixtureJSON(_ path: String) async throws -> [String: Any] {
        let (data, _) = try await URLSession.shared.data(from: fixtureURL.appendingPathComponent(path))
        return try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
    }

    override func tearDown() async throws {
        await MainActor.run { app?.terminate() }
    }

    // MARK: Queries

    /// Any element whose accessibility label is exactly `label`.
    @MainActor
    func element(_ label: String) -> XCUIElement {
        app.descendants(matching: .any).matching(NSPredicate(format: "label == %@", label)).firstMatch
    }

    /// Any element whose accessibility label starts with `prefix`.
    @MainActor
    func element(startingWith prefix: String) -> XCUIElement {
        app.descendants(matching: .any).matching(NSPredicate(format: "label BEGINSWITH %@", prefix)).firstMatch
    }

    @MainActor
    func navigationTitle(_ title: String) -> XCUIElement {
        app.navigationBars[title]
    }

    // MARK: Waiting and actions

    @MainActor
    @discardableResult
    func waitFor(
        _ element: XCUIElement,
        timeout: TimeInterval = 10,
        file: StaticString = #filePath,
        line: UInt = #line
    ) -> XCUIElement {
        XCTAssertTrue(element.waitForExistence(timeout: timeout), "Missing \(element)", file: file, line: line)
        return element
    }

    @MainActor
    func waitForAbsence(
        _ element: XCUIElement,
        timeout: TimeInterval = 10,
        file: StaticString = #filePath,
        line: UInt = #line
    ) {
        let gone = XCTNSPredicateExpectation(predicate: NSPredicate(format: "exists == false"), object: element)
        XCTAssertEqual(XCTWaiter.wait(for: [gone], timeout: timeout), .completed, "Still present: \(element)", file: file, line: line)
    }

    @MainActor
    func tap(_ label: String, file: StaticString = #filePath, line: UInt = #line) {
        waitFor(element(label), file: file, line: line).tap()
    }

    /// Swipes the frontmost scrollable content up until `element` is materialized and hittable;
    /// lazy lists only create rows near the viewport.
    @MainActor
    @discardableResult
    func scrollTo(_ element: XCUIElement, file: StaticString = #filePath, line: UInt = #line) -> XCUIElement {
        for _ in 0..<8 {
            if element.exists, element.isHittable { return element }
            app.swipeUp()
        }
        XCTAssertTrue(element.exists && element.isHittable, "Could not scroll to \(element)", file: file, line: line)
        return element
    }

    /// Replaces a text field's contents; sheets often prefill a suggested value.
    @MainActor
    func replaceText(of field: XCUIElement, with text: String) {
        field.tap()
        let current = field.value as? String ?? ""
        let placeholder = field.placeholderValue ?? ""
        if !current.isEmpty, current != placeholder {
            field.typeText(String(repeating: XCUIKeyboardKey.delete.rawValue, count: current.count))
        }
        field.typeText(text)
    }

    /// Waits until `element` reports enabled (state that settles after asynchronous work).
    @MainActor
    func waitForEnabled(
        _ element: XCUIElement,
        timeout: TimeInterval = 10,
        file: StaticString = #filePath,
        line: UInt = #line
    ) {
        let enabled = XCTNSPredicateExpectation(predicate: NSPredicate(format: "isEnabled == true"), object: element)
        XCTAssertEqual(XCTWaiter.wait(for: [enabled], timeout: timeout), .completed, "Never enabled: \(element)", file: file, line: line)
    }

    /// Waits for the Library grid, then scrolls it until `label` is materialized and hittable.
    @MainActor
    func gridCell(_ label: String, file: StaticString = #filePath, line: UInt = #line) -> XCUIElement {
        let cell = element(label)
        if cell.waitForExistence(timeout: 10), cell.isHittable { return cell }
        let grid = app.collectionViews.firstMatch
        for direction in [true, false] {
            for _ in 0..<6 {
                direction ? grid.swipeDown() : grid.swipeUp()
                if cell.exists, cell.isHittable { return cell }
            }
        }
        XCTFail("No grid cell labeled \(label)", file: file, line: line)
        return cell
    }

    @MainActor
    func openLibrary() {
        app.tabBars.buttons["Library"].tap()
        waitFor(app.staticTexts["Library"])
    }

    @MainActor
    func openCollections() {
        app.tabBars.buttons["Collections"].tap()
        waitFor(navigationTitle("Collections"))
    }

    /// Opens the Library's Browse menu (its label carries the duplicate-group count).
    @MainActor
    func openBrowseMenu() {
        waitFor(element(startingWith: "Browse")).tap()
    }

    @MainActor
    func goBack() {
        app.navigationBars.buttons.element(boundBy: 0).tap()
    }
}
