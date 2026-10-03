import XCTest
@testable import PhotoBrain

@MainActor
final class SearchStateTests: XCTestCase {
    func testTrimmedDebounceIsGenerationFencedAndLimitedToNewestQuery() async {
        let api = TestAPI()
        await api.setSearch(
            query: "first",
            delay: .milliseconds(500),
            response: SearchResponseDTO(photos: [TestModels.photo(id: 1)], total: 1, query: "first")
        )
        await api.setSearch(
            query: "second",
            delay: .zero,
            response: SearchResponseDTO(photos: [TestModels.photo(id: 2)], total: 1, query: "second")
        )
        let store = SearchStore(api: api)
        store.query = "  first  "
        try? await Task.sleep(for: .milliseconds(400))
        store.query = " second "
        try? await Task.sleep(for: .milliseconds(450))

        XCTAssertEqual(store.records.map(\.id), [2])
        XCTAssertEqual(store.state, .results)
    }

    func testWhitespaceOnlyQueryCancelsAndReturnsToIdle() {
        let store = SearchStore(api: TestAPI())
        store.query = "   \n "
        XCTAssertEqual(store.state, .idle)
        XCTAssertTrue(store.records.isEmpty)
    }
}
