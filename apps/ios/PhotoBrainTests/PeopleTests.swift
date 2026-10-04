import XCTest
@testable import PhotoBrain

final class PeopleDTOTests: XCTestCase {
    private let decoder = APIModelCoding.decoder()

    func testPersonDecodesAllFields() throws {
        let json = #"{"id":7,"name":"Ada","hidden":false,"photoCount":12,"faceCount":15,"coverFaceId":42}"#
        let person = try decoder.decode(PersonDTO.self, from: Data(json.utf8))
        XCTAssertEqual(
            person,
            PersonDTO(id: 7, name: "Ada", hidden: false, photoCount: 12, faceCount: 15, coverFaceId: 42)
        )
    }

    func testPersonDecodesNullNameAndCover() throws {
        let json = #"{"id":3,"name":null,"hidden":true,"photoCount":0,"faceCount":0,"coverFaceId":null}"#
        let person = try decoder.decode(PersonDTO.self, from: Data(json.utf8))
        XCTAssertNil(person.name)
        XCTAssertNil(person.coverFaceId)
        XCTAssertTrue(person.hidden)
        XCTAssertNil(person.coverURL(apiBaseURL: URL(string: "https://photos.example.test")!))
    }

    func testPeopleResponsePreservesServerOrder() throws {
        let json = #"{"people":["#
            + #"{"id":9,"name":"Zed","hidden":false,"photoCount":1,"faceCount":1,"coverFaceId":90},"#
            + #"{"id":2,"name":"Ada","hidden":false,"photoCount":30,"faceCount":31,"coverFaceId":20},"#
            + #"{"id":5,"name":null,"hidden":false,"photoCount":50,"faceCount":50,"coverFaceId":null}"#
            + #"]}"#
        let response = try decoder.decode(PeopleResponseDTO.self, from: Data(json.utf8))
        XCTAssertEqual(response.people.map(\.id), [9, 2, 5])
    }

    func testPhotoFacesDecodeBoxesAssignmentsAndNullPerson() throws {
        let json = #"{"faces":["#
            + #"{"id":1,"box":{"x":0.1,"y":0.2,"width":0.3,"height":0.4},"personId":7,"personName":"Ada","assignment":"manual"},"#
            + #"{"id":2,"box":{"x":0.5,"y":0.25,"width":0.1,"height":0.12},"personId":8,"personName":null,"assignment":"auto"},"#
            + #"{"id":3,"box":{"x":0.8,"y":0.1,"width":0.1,"height":0.1},"personId":null,"personName":null,"assignment":"rejected"}"#
            + #"]}"#
        let response = try decoder.decode(PhotoFacesResponseDTO.self, from: Data(json.utf8))
        XCTAssertEqual(response.faces.map(\.id), [1, 2, 3])
        XCTAssertEqual(response.faces[0].box, FaceBoxDTO(x: 0.1, y: 0.2, width: 0.3, height: 0.4))
        XCTAssertEqual(response.faces.map(\.assignment), [.manual, .auto, .rejected])
        XCTAssertEqual(response.faces[1].personId, 8)
        XCTAssertNil(response.faces[1].personName)
        XCTAssertNil(response.faces[2].personId)
    }

    func testUnknownAssignmentFailsToDecode() {
        let json = #"{"id":1,"box":{"x":0,"y":0,"width":1,"height":1},"personId":null,"personName":null,"assignment":"maybe"}"#
        XCTAssertThrowsError(try decoder.decode(PhotoFaceDTO.self, from: Data(json.utf8)))
    }

    func testFaceCropURL() {
        let base = URL(string: "https://photos.example.test")!
        XCTAssertEqual(
            FaceCrop.url(baseURL: base, faceID: 42).absoluteString,
            "https://photos.example.test/api/faces/42/crop?size=256"
        )
        XCTAssertEqual(
            FaceCrop.url(baseURL: base, faceID: 42, size: 128).absoluteString,
            "https://photos.example.test/api/faces/42/crop?size=128"
        )
        let person = PersonDTO(id: 1, name: "Ada", hidden: false, photoCount: 1, faceCount: 1, coverFaceId: 42)
        XCTAssertEqual(person.coverURL(apiBaseURL: base), FaceCrop.url(baseURL: base, faceID: 42))
    }

    func testPersonNameRules() throws {
        XCTAssertEqual(try PersonName.validated("  Ada  "), "Ada")
        XCTAssertNil(try PersonName.validatedOptional("   "))
        XCTAssertThrowsError(try PersonName.validated(" ")) { error in
            XCTAssertEqual(error as? PersonNameError, .empty)
        }
        XCTAssertThrowsError(try PersonName.validated(String(repeating: "a", count: 81))) { error in
            XCTAssertEqual(error as? PersonNameError, .tooLong)
        }
        XCTAssertEqual(try PersonName.validated(String(repeating: "a", count: 80)).count, 80)
    }

    func testMergeRules() {
        XCTAssertTrue(PeopleMerge.isValid(targetId: 1, sourceIds: [2, 3]))
        XCTAssertFalse(PeopleMerge.isValid(targetId: 1, sourceIds: []))
        XCTAssertFalse(PeopleMerge.isValid(targetId: 1, sourceIds: [1, 2]))
        XCTAssertFalse(PeopleMerge.isValid(targetId: 1, sourceIds: [2, 2]))
        XCTAssertFalse(PeopleMerge.isValid(targetId: 1, sourceIds: Array(2...52)))
        XCTAssertTrue(PeopleMerge.isValid(targetId: 1, sourceIds: Array(2...51)))
    }

    func testPersonErrorCodesMapToMessages() {
        let person = PhotoBrainAPIError.server(status: 404, code: "PERSON_NOT_FOUND", message: "Person not found")
        let face = PhotoBrainAPIError.server(status: 404, code: "FACE_NOT_FOUND", message: "Face not found")
        XCTAssertEqual(person.errorDescription, "This person no longer exists.")
        XCTAssertEqual(face.errorDescription, "This face is no longer in the photo.")
        XCTAssertEqual(person.code, "PERSON_NOT_FOUND")
        XCTAssertEqual(face.code, "FACE_NOT_FOUND")
        XCTAssertFalse(person.isRetryable)
    }
}

final class PeopleAPITests: XCTestCase {
    private static let personJSON = #"{"id":7,"name":"Ada","hidden":false,"photoCount":2,"faceCount":3,"coverFaceId":11}"#
    private static let faceJSON = #"{"id":5,"box":{"x":0.1,"y":0.2,"width":0.3,"height":0.4},"#
        + #""personId":7,"personName":"Ada","assignment":"manual"}"#

    override func tearDown() {
        StubURLProtocol.reset()
        super.tearDown()
    }

    func testPeopleListIsGetWithoutHiddenByDefault() async throws {
        StubURLProtocol.respond(status: 200, body: #"{"people":[\#(Self.personJSON)]}"#)
        let response = try await StubURLProtocol.makeClient().people(includeHidden: false)
        let request = try onlyRequest()
        XCTAssertEqual(request.httpMethod, "GET")
        XCTAssertEqual(request.url?.path, "/api/v1/people")
        XCTAssertNil(request.url?.query)
        XCTAssertEqual(response.people.map(\.id), [7])
    }

    func testPeopleListSendsIncludeHidden() async throws {
        StubURLProtocol.respond(status: 200, body: #"{"people":[]}"#)
        _ = try await StubURLProtocol.makeClient().people(includeHidden: true)
        XCTAssertEqual(try onlyRequest().url?.query, "includeHidden=true")
    }

    func testPersonIsGet() async throws {
        StubURLProtocol.respond(status: 200, body: Self.personJSON)
        let person = try await StubURLProtocol.makeClient().person(id: 7)
        let request = try onlyRequest()
        XCTAssertEqual(request.httpMethod, "GET")
        XCTAssertEqual(request.url?.path, "/api/v1/people/7")
        XCTAssertEqual(person.name, "Ada")
    }

    func testUnknownPersonMapsToPersonNotFound() async {
        StubURLProtocol.respond(
            status: 404,
            body: #"{"error":{"code":"PERSON_NOT_FOUND","message":"Person not found"}}"#
        )
        await assertThrows(.server(status: 404, code: "PERSON_NOT_FOUND", message: "Person not found")) {
            _ = try await StubURLProtocol.makeClient().person(id: 99)
        }
    }

    func testRenameIsPatchWithTrimmedNameOnly() async throws {
        StubURLProtocol.respond(status: 200, body: Self.personJSON)
        _ = try await StubURLProtocol.makeClient().updatePerson(id: 7, name: .some("  Ada "), hidden: nil)
        let request = try onlyRequest()
        XCTAssertEqual(request.httpMethod, "PATCH")
        XCTAssertEqual(request.url?.path, "/api/v1/people/7")
        XCTAssertEqual(String(data: try XCTUnwrap(request.httpBody), encoding: .utf8), #"{"name":"Ada"}"#)
    }

    func testClearingNameSendsExplicitNull() async throws {
        StubURLProtocol.respond(status: 200, body: Self.personJSON)
        _ = try await StubURLProtocol.makeClient().updatePerson(id: 7, name: .some(nil), hidden: nil)
        XCTAssertEqual(String(data: try XCTUnwrap(try onlyRequest().httpBody), encoding: .utf8), #"{"name":null}"#)
    }

    func testHideSendsHiddenOnly() async throws {
        StubURLProtocol.respond(status: 200, body: Self.personJSON)
        _ = try await StubURLProtocol.makeClient().updatePerson(id: 7, name: nil, hidden: true)
        XCTAssertEqual(String(data: try XCTUnwrap(try onlyRequest().httpBody), encoding: .utf8), #"{"hidden":true}"#)
    }

    func testEmptyUpdateSendsNoRequest() async {
        await assertThrows(.invalidRequest) {
            _ = try await StubURLProtocol.makeClient().updatePerson(id: 7, name: nil, hidden: nil)
        }
        XCTAssertTrue(StubURLProtocol.requests.isEmpty)
    }

    func testMergeIsPostWithSourceIds() async throws {
        StubURLProtocol.respond(status: 200, body: Self.personJSON)
        _ = try await StubURLProtocol.makeClient().mergePeople(targetId: 7, sourceIds: [3, 4])
        let request = try onlyRequest()
        XCTAssertEqual(request.httpMethod, "POST")
        XCTAssertEqual(request.url?.path, "/api/v1/people/7/merge")
        XCTAssertEqual(try jsonBody(request) as NSDictionary, ["sourceIds": [3, 4]] as NSDictionary)
    }

    func testInvalidMergeSendsNoRequest() async {
        await assertThrows(.invalidRequest) {
            _ = try await StubURLProtocol.makeClient().mergePeople(targetId: 7, sourceIds: [7])
        }
        XCTAssertTrue(StubURLProtocol.requests.isEmpty)
    }

    func testPhotoFacesIsGet() async throws {
        StubURLProtocol.respond(status: 200, body: #"{"faces":[\#(Self.faceJSON)]}"#)
        let response = try await StubURLProtocol.makeClient().photoFaces(photoId: 12)
        let request = try onlyRequest()
        XCTAssertEqual(request.httpMethod, "GET")
        XCTAssertEqual(request.url?.path, "/api/v1/photos/12/faces")
        XCTAssertEqual(response.faces.map(\.id), [5])
    }

    func testAssignToPersonSendsPersonID() async throws {
        StubURLProtocol.respond(status: 200, body: Self.faceJSON)
        _ = try await StubURLProtocol.makeClient().assignFace(faceId: 5, to: .person(7))
        let request = try onlyRequest()
        XCTAssertEqual(request.httpMethod, "PUT")
        XCTAssertEqual(request.url?.path, "/api/v1/faces/5/person")
        XCTAssertEqual(String(data: try XCTUnwrap(request.httpBody), encoding: .utf8), #"{"personId":7}"#)
    }

    func testAssignToNewPersonSendsTrimmedNameOnly() async throws {
        StubURLProtocol.respond(status: 200, body: Self.faceJSON)
        _ = try await StubURLProtocol.makeClient().assignFace(faceId: 5, to: .newPerson(name: "  Grace "))
        XCTAssertEqual(String(data: try XCTUnwrap(try onlyRequest().httpBody), encoding: .utf8), #"{"name":"Grace"}"#)
    }

    func testNotThisPersonSendsNullPersonID() async throws {
        StubURLProtocol.respond(status: 200, body: Self.faceJSON)
        _ = try await StubURLProtocol.makeClient().assignFace(faceId: 5, to: .notThisPerson)
        XCTAssertEqual(String(data: try XCTUnwrap(try onlyRequest().httpBody), encoding: .utf8), #"{"personId":null}"#)
    }

    func testBlankNewPersonSendsNoRequest() async {
        do {
            _ = try await StubURLProtocol.makeClient().assignFace(faceId: 5, to: .newPerson(name: "  "))
            XCTFail("Expected a validation error")
        } catch {
            XCTAssertEqual(error as? PersonNameError, .empty)
        }
        XCTAssertTrue(StubURLProtocol.requests.isEmpty)
    }

    func testUnknownFaceMapsToFaceNotFound() async {
        StubURLProtocol.respond(
            status: 404,
            body: #"{"error":{"code":"FACE_NOT_FOUND","message":"Face not found"}}"#
        )
        await assertThrows(.server(status: 404, code: "FACE_NOT_FOUND", message: "Face not found")) {
            _ = try await StubURLProtocol.makeClient().assignFace(faceId: 5, to: .notThisPerson)
        }
    }

    func testPhotosQuerySendsPersonIDAfterTag() async throws {
        StubURLProtocol.respond(status: 200, body: #"{"photos":[],"total":0,"rawCount":0}"#)
        _ = try await StubURLProtocol.makeClient().photos(query: PhotoQuery(tag: "dog", personId: 7))
        let items = URLComponents(url: try XCTUnwrap(try onlyRequest().url), resolvingAgainstBaseURL: false)?.queryItems
        XCTAssertEqual(items, [
            URLQueryItem(name: "filterRaw", value: "all"),
            URLQueryItem(name: "tag", value: "dog"),
            URLQueryItem(name: "personId", value: "7"),
        ])
    }

    func testPhotosQueryOmitsPersonIDWhenUnset() {
        XCTAssertFalse(PhotoQuery(tag: "dog").queryItems.contains { $0.name == "personId" })
    }

    func testSearchBodySendsPersonID() async throws {
        StubURLProtocol.respond(status: 200, body: #"{"photos":[],"total":0,"query":"beach"}"#)
        _ = try await StubURLProtocol.makeClient().search(query: "beach", limit: 20, filters: PhotoQuery(personId: 7))
        let body = try jsonBody(try onlyRequest())
        XCTAssertEqual(body["personId"] as? Int, 7)
        XCTAssertEqual(body["query"] as? String, "beach")
    }

    func testSearchBodyOmitsPersonIDWhenUnset() async throws {
        StubURLProtocol.respond(status: 200, body: #"{"photos":[],"total":0,"query":"beach"}"#)
        _ = try await StubURLProtocol.makeClient().search(query: "beach", limit: 20, filters: PhotoQuery())
        XCTAssertNil(try jsonBody(try onlyRequest())["personId"])
    }

    func testSmartAlbumFiltersRoundTripPersonID() throws {
        let filters = SmartAlbumFilters(tag: "dog", personId: 7)
        let data = try APIModelCoding.encoder().encode(filters)
        let object = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
        XCTAssertEqual(object["personId"] as? Int, 7)
        XCTAssertEqual(try APIModelCoding.decoder().decode(SmartAlbumFilters.self, from: data), filters)
        XCTAssertEqual(filters.photoQuery.personId, 7)
        XCTAssertFalse(SmartAlbumFilters(personId: 7).isEmpty)
    }

    private func onlyRequest() throws -> URLRequest {
        XCTAssertEqual(StubURLProtocol.requests.count, 1)
        return try XCTUnwrap(StubURLProtocol.requests.first)
    }

    private func jsonBody(_ request: URLRequest) throws -> [String: Any] {
        let data = try XCTUnwrap(request.httpBody)
        return try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
    }

    private func assertThrows(
        _ expected: PhotoBrainAPIError,
        file: StaticString = #filePath,
        line: UInt = #line,
        _ operation: () async throws -> Void
    ) async {
        do {
            try await operation()
            XCTFail("Expected \(expected)", file: file, line: line)
        } catch {
            XCTAssertEqual(error as? PhotoBrainAPIError, expected, file: file, line: line)
        }
    }
}

@MainActor
final class PeopleStoreTests: XCTestCase {
    private func loadedStore(_ people: [PersonDTO]) async -> (PeopleStore, TestAPI) {
        let api = TestAPI()
        await api.setPeople(people)
        let store = PeopleStore(api: api)
        await store.load()
        return (store, api)
    }

    private func mutations(_ api: TestAPI) async -> [TestAPI.PeopleRequest] {
        await api.recordedPeopleRequests().filter {
            if case .list = $0 { return false }
            return true
        }
    }

    func testLoadKeepsServerOrder() async {
        let (store, api) = await loadedStore([
            TestModels.person(id: 9, name: "Zed", photoCount: 1),
            TestModels.person(id: 2, name: "Ada", photoCount: 30),
            TestModels.person(id: 5, photoCount: 50),
        ])
        XCTAssertEqual(store.loadState, .loaded)
        XCTAssertEqual(store.people.map(\.id), [9, 2, 5])
        let requests = await api.recordedPeopleRequests()
        XCTAssertEqual(requests, [.list(includeHidden: false)])
    }

    func testFirstLoadFailureIsFailedState() async {
        let api = TestAPI()
        await api.setPeopleFailure(.list, .transport("Offline"))
        let store = PeopleStore(api: api)
        await store.load()
        XCTAssertEqual(store.loadState, .failed("Offline"))
        XCTAssertTrue(store.people.isEmpty)
    }

    func testLaterLoadFailureKeepsListAndSurfacesError() async {
        let (store, api) = await loadedStore([TestModels.person(id: 1, name: "Ada")])
        await api.setPeopleFailure(.list, .transport("Offline"))
        await store.load()
        XCTAssertEqual(store.loadState, .loaded)
        XCTAssertEqual(store.people.map(\.id), [1])
        XCTAssertEqual(store.errorMessage, "Offline")
    }

    func testFeaturedIsFirstTwelveVisibleInOrder() async {
        var people = (1...14).map { TestModels.person(id: $0, name: "P\($0)") }
        people[1].hidden = true
        let (store, _) = await loadedStore(people)
        await store.setIncludeHidden(true)
        XCTAssertEqual(store.people.count, 14)
        XCTAssertEqual(store.featured.map(\.id), [1] + Array(3...13))
    }

    func testShowHiddenReloadsWithIncludeHidden() async {
        let (store, api) = await loadedStore([
            TestModels.person(id: 1, name: "Ada"),
            TestModels.person(id: 2, name: "Hidden", hidden: true),
        ])
        XCTAssertEqual(store.people.map(\.id), [1])
        await store.setIncludeHidden(true)
        XCTAssertTrue(store.includeHidden)
        XCTAssertEqual(store.people.map(\.id), [1, 2])
        let requests = await api.recordedPeopleRequests()
        XCTAssertEqual(requests, [.list(includeHidden: false), .list(includeHidden: true)])
    }

    func testSearchMatchesNamesInOrder() async {
        let (store, _) = await loadedStore([
            TestModels.person(id: 1, name: "Zoë Adams"),
            TestModels.person(id: 2),
            TestModels.person(id: 3, name: "Ada"),
            TestModels.person(id: 4, name: "Bob"),
        ])
        XCTAssertEqual(store.matching("  ").map(\.id), [1, 2, 3, 4])
        XCTAssertEqual(store.matching("ada").map(\.id), [1, 3])
        XCTAssertEqual(store.matching("zoe").map(\.id), [1])
        XCTAssertEqual(store.matching("nobody").map(\.id), [])
    }

    func testRenameAppliesImmediatelyAndConfirms() async throws {
        let (store, api) = await loadedStore([TestModels.person(id: 1), TestModels.person(id: 2, name: "Bob")])
        await api.setPeopleDelay(.milliseconds(200))
        let task = Task { await store.rename(id: 1, to: "  Ada ") }
        try await waitUntil { store.people.first?.name == "Ada" }
        let renamed = await task.value
        XCTAssertTrue(renamed)
        XCTAssertEqual(store.people.map(\.name), ["Ada", "Bob"])
        let sent = await mutations(api)
        XCTAssertEqual(sent, [.update(id: 1, name: .some("Ada"), hidden: nil)])
    }

    func testRenameRollsBackOnFailure() async {
        let (store, api) = await loadedStore([TestModels.person(id: 1, name: "Ada"), TestModels.person(id: 2)])
        await api.setPeopleFailure(.update, .transport("Offline"))
        let renamed = await store.rename(id: 1, to: "Grace")
        XCTAssertFalse(renamed)
        XCTAssertEqual(store.people.map(\.name), ["Ada", nil])
        XCTAssertEqual(store.errorMessage, "Offline")
    }

    func testBlankRenameClearsTheName() async {
        let (store, api) = await loadedStore([TestModels.person(id: 1, name: "Ada")])
        let renamed = await store.rename(id: 1, to: "   ")
        XCTAssertTrue(renamed)
        XCTAssertNil(store.people.first?.name)
        let sent = await mutations(api)
        XCTAssertEqual(sent, [.update(id: 1, name: .some(nil), hidden: nil)])
    }

    func testTooLongRenameSendsNothing() async {
        let (store, api) = await loadedStore([TestModels.person(id: 1, name: "Ada")])
        let renamed = await store.rename(id: 1, to: String(repeating: "x", count: 81))
        XCTAssertFalse(renamed)
        XCTAssertEqual(store.errorMessage, "Names can be at most 80 characters.")
        let sent = await mutations(api)
        XCTAssertEqual(sent, [])
    }

    func testRenameOfDeletedPersonRollsBackAndRefreshes() async throws {
        let (store, api) = await loadedStore([TestModels.person(id: 1, name: "Ada"), TestModels.person(id: 2)])
        await api.setPeople([TestModels.person(id: 2)])
        let renamed = await store.rename(id: 1, to: "Grace")
        XCTAssertFalse(renamed)
        XCTAssertEqual(store.errorMessage, "This person no longer exists.")
        try await waitUntil { store.people.map(\.id) == [2] }
    }

    func testHideRemovesWhileHiddenExcludedAndConfirms() async {
        let (store, api) = await loadedStore([
            TestModels.person(id: 1, name: "Ada"),
            TestModels.person(id: 2, name: "Bob"),
        ])
        let hidden = await store.setHidden(id: 1, true)
        XCTAssertTrue(hidden)
        XCTAssertEqual(store.people.map(\.id), [2])
        let sent = await mutations(api)
        XCTAssertEqual(sent, [.update(id: 1, name: nil, hidden: true)])
    }

    func testHideRollsBackToOriginalPosition() async {
        let (store, api) = await loadedStore([
            TestModels.person(id: 1, name: "Ada"),
            TestModels.person(id: 2, name: "Bob"),
            TestModels.person(id: 3, name: "Cy"),
        ])
        await api.setPeopleFailure(.update, .transport("Offline"))
        let hidden = await store.setHidden(id: 2, true)
        XCTAssertFalse(hidden)
        XCTAssertEqual(store.people.map(\.id), [1, 2, 3])
        XCTAssertEqual(store.people[1].hidden, false)
        XCTAssertEqual(store.errorMessage, "Offline")
    }

    func testUnhideWhileShowingHiddenTogglesInPlace() async {
        let (store, _) = await loadedStore([
            TestModels.person(id: 1, name: "Ada", hidden: true),
            TestModels.person(id: 2, name: "Bob"),
        ])
        await store.setIncludeHidden(true)
        let unhidden = await store.setHidden(id: 1, false)
        XCTAssertTrue(unhidden)
        XCTAssertEqual(store.people.map(\.id), [1, 2])
        XCTAssertEqual(store.people.first?.hidden, false)
    }

    func testUnhideRollsBackOnFailure() async {
        let (store, api) = await loadedStore([TestModels.person(id: 1, name: "Ada", hidden: true)])
        await store.setIncludeHidden(true)
        await api.setPeopleFailure(.update, .transport("Offline"))
        let unhidden = await store.setHidden(id: 1, false)
        XCTAssertFalse(unhidden)
        XCTAssertEqual(store.people.first?.hidden, true)
    }

    func testMergeFoldsSourcesOptimisticallyAndConfirms() async throws {
        let (store, api) = await loadedStore([
            TestModels.person(id: 1, name: "Ada", photoCount: 5, faceCount: 6, coverFaceId: 10),
            TestModels.person(id: 2, photoCount: 3, faceCount: 3, coverFaceId: 20),
            TestModels.person(id: 3, name: "Bob", photoCount: 2, faceCount: 2),
        ])
        await api.setPeopleDelay(.milliseconds(200))
        let task = Task { await store.merge(targetId: 2, sourceIds: [3, 1]) }
        try await waitUntil { store.people.count == 1 }
        let optimistic = try XCTUnwrap(store.people.first)
        XCTAssertEqual(optimistic.id, 2)
        XCTAssertEqual(optimistic.photoCount, 10)
        XCTAssertEqual(optimistic.faceCount, 11)
        XCTAssertEqual(optimistic.name, "Bob", "An unnamed target takes the first named source's name in sourceIds order")
        XCTAssertEqual(optimistic.coverFaceId, 20)
        let merged = await task.value
        XCTAssertTrue(merged)
        XCTAssertEqual(store.people.map(\.id), [2])
        let sent = await mutations(api)
        XCTAssertEqual(sent, [.merge(targetId: 2, sourceIds: [3, 1])])
    }

    func testMergeRollsBackEveryEntryInPlace() async {
        let people = [
            TestModels.person(id: 1, name: "Ada", photoCount: 5),
            TestModels.person(id: 2, photoCount: 3),
            TestModels.person(id: 3, name: "Bob", photoCount: 2),
            TestModels.person(id: 4, name: "Cy", photoCount: 1),
        ]
        let (store, api) = await loadedStore(people)
        await api.setPeopleFailure(.merge, .transport("Offline"))
        let merged = await store.merge(targetId: 2, sourceIds: [1, 4])
        XCTAssertFalse(merged)
        XCTAssertEqual(store.people, people)
        XCTAssertEqual(store.errorMessage, "Offline")
    }

    func testInvalidMergeSendsNothing() async {
        let (store, api) = await loadedStore([TestModels.person(id: 1, name: "Ada")])
        let merged = await store.merge(targetId: 1, sourceIds: [1])
        XCTAssertFalse(merged)
        XCTAssertNotNil(store.errorMessage)
        let sent = await mutations(api)
        XCTAssertEqual(sent, [])
    }

    func testStaleListResponseDoesNotOverwriteMutation() async throws {
        let (store, api) = await loadedStore([TestModels.person(id: 1, name: "Ada")])
        await api.setPeopleDelay(.milliseconds(150))
        let reload = Task { await store.load() }
        try await Task.sleep(for: .milliseconds(20))
        await api.setPeopleDelay(.zero)
        let renamed = await store.rename(id: 1, to: "Grace")
        await reload.value
        XCTAssertTrue(renamed)
        XCTAssertEqual(store.people.first?.name, "Grace")
    }
}

@MainActor
final class PhotoFacesStoreTests: XCTestCase {
    private func loadedFaces(
        people: [PersonDTO] = [TestModels.person(id: 7, name: "Ada")],
        faces: [PhotoFaceDTO]
    ) async -> (PhotoFacesStore, TestAPI) {
        let api = TestAPI()
        await api.setPeople(people, faces: [12: faces])
        let store = PhotoFacesStore(photoID: 12, api: api)
        await store.load()
        return (store, api)
    }

    private func assignRequests(_ api: TestAPI) async -> [TestAPI.PeopleRequest] {
        await api.recordedPeopleRequests().filter {
            if case .assign = $0 { return true }
            return false
        }
    }

    func testLoadKeepsLeftToRightOrder() async {
        let (store, _) = await loadedFaces(faces: [
            TestModels.face(id: 3, x: 0.1),
            TestModels.face(id: 1, x: 0.5),
            TestModels.face(id: 2, x: 0.8),
        ])
        XCTAssertEqual(store.faces.map(\.id), [3, 1, 2])
    }

    func testLoadFailureIsFailedState() async {
        let api = TestAPI()
        await api.setPeopleFailure(.faces, .transport("Offline"))
        let store = PhotoFacesStore(photoID: 12, api: api)
        await store.load()
        XCTAssertEqual(store.state, .failed("Offline"))
    }

    func testAssignToExistingPersonIsOptimisticAndConfirmed() async throws {
        let (store, api) = await loadedFaces(faces: [TestModels.face(id: 1)])
        var assignedCount = 0
        store.onAssigned = { assignedCount += 1 }
        await api.setPeopleDelay(.milliseconds(200))
        let task = Task { await store.assign(faceId: 1, to: .person(7), displayName: "Ada") }
        try await waitUntil { store.faces.first?.personId == 7 }
        XCTAssertEqual(store.faces.first?.personName, "Ada")
        XCTAssertEqual(store.faces.first?.assignment, .manual)
        XCTAssertEqual(store.pendingFaceIDs, [1])
        let assigned = await task.value
        XCTAssertTrue(assigned)
        XCTAssertEqual(store.pendingFaceIDs, [])
        XCTAssertEqual(assignedCount, 1)
        let sent = await assignRequests(api)
        XCTAssertEqual(sent, [.assign(faceId: 1, target: .person(7))])
    }

    func testAssignToNewPersonSendsTrimmedNameAndTakesServerPerson() async throws {
        let (store, api) = await loadedFaces(faces: [TestModels.face(id: 1)])
        await api.setPeopleDelay(.milliseconds(200))
        let task = Task { await store.assign(faceId: 1, to: .newPerson(name: "  Grace ")) }
        try await waitUntil { store.faces.first?.personName == "Grace" }
        XCTAssertNil(store.faces.first?.personId, "The new person's id is unknown until the server replies")
        XCTAssertEqual(store.faces.first?.assignment, .manual)
        let assigned = await task.value
        XCTAssertTrue(assigned)
        XCTAssertEqual(store.faces.first?.personId, 8)
        let sent = await assignRequests(api)
        XCTAssertEqual(sent, [.assign(faceId: 1, target: .newPerson(name: "Grace"))])
        let serverPeople = await api.serverPeople()
        XCTAssertEqual(serverPeople.last?.name, "Grace")
    }

    func testNotThisPersonRejectsTheFace() async {
        let (store, api) = await loadedFaces(faces: [
            TestModels.face(id: 1, personId: 7, personName: "Ada", assignment: .auto),
        ])
        let assigned = await store.assign(faceId: 1, to: .notThisPerson)
        XCTAssertTrue(assigned)
        XCTAssertNil(store.faces.first?.personId)
        XCTAssertNil(store.faces.first?.personName)
        XCTAssertEqual(store.faces.first?.assignment, .rejected)
        let sent = await assignRequests(api)
        XCTAssertEqual(sent, [.assign(faceId: 1, target: .notThisPerson)])
    }

    func testAssignRollsBackForEachMode() async {
        let original = TestModels.face(id: 1, personId: 7, personName: "Ada", assignment: .auto)
        let targets: [FaceAssignmentTarget] = [.person(9), .newPerson(name: "Grace"), .notThisPerson]
        for target in targets {
            let (store, api) = await loadedFaces(
                people: [TestModels.person(id: 7, name: "Ada"), TestModels.person(id: 9, name: "Bob")],
                faces: [original]
            )
            var assignedCount = 0
            store.onAssigned = { assignedCount += 1 }
            await api.setPeopleFailure(.assign, .transport("Offline"))
            let assigned = await store.assign(faceId: 1, to: target, displayName: "Bob")
            XCTAssertFalse(assigned, "\(target)")
            XCTAssertEqual(store.faces, [original], "\(target)")
            XCTAssertEqual(store.errorMessage, "Offline", "\(target)")
            XCTAssertEqual(store.pendingFaceIDs, [], "\(target)")
            XCTAssertEqual(assignedCount, 0, "\(target)")
        }
    }

    func testAssignToDeletedPersonRollsBackAndRefreshesPeople() async {
        let original = TestModels.face(id: 1)
        let (store, _) = await loadedFaces(faces: [original])
        var assignedCount = 0
        store.onAssigned = { assignedCount += 1 }
        let assigned = await store.assign(faceId: 1, to: .person(99), displayName: "Ghost")
        XCTAssertFalse(assigned)
        XCTAssertEqual(store.faces, [original])
        XCTAssertEqual(store.errorMessage, "This person no longer exists.")
        XCTAssertEqual(assignedCount, 1, "A missing person refreshes the people list")
    }

    func testAssignToVanishedFaceRemovesIt() async {
        let (store, api) = await loadedFaces(faces: [TestModels.face(id: 1), TestModels.face(id: 2, x: 0.6)])
        await api.setPeopleFailure(
            .assign,
            .server(status: 404, code: "FACE_NOT_FOUND", message: "Face not found")
        )
        let assigned = await store.assign(faceId: 1, to: .notThisPerson)
        XCTAssertFalse(assigned)
        XCTAssertEqual(store.faces.map(\.id), [2])
        XCTAssertEqual(store.errorMessage, "This face is no longer in the photo.")
    }

    func testBlankNewPersonSendsNothing() async {
        let original = TestModels.face(id: 1)
        let (store, api) = await loadedFaces(faces: [original])
        let assigned = await store.assign(faceId: 1, to: .newPerson(name: "   "))
        XCTAssertFalse(assigned)
        XCTAssertEqual(store.faces, [original])
        XCTAssertEqual(store.errorMessage, "Enter a name.")
        let sent = await assignRequests(api)
        XCTAssertEqual(sent, [])
    }

    func testSecondAssignWhilePendingIsIgnored() async throws {
        let (store, api) = await loadedFaces(faces: [TestModels.face(id: 1)])
        await api.setPeopleDelay(.milliseconds(200))
        let first = Task { await store.assign(faceId: 1, to: .person(7), displayName: "Ada") }
        try await waitUntil { store.pendingFaceIDs == [1] }
        let second = await store.assign(faceId: 1, to: .notThisPerson)
        XCTAssertFalse(second)
        _ = await first.value
        let sent = await assignRequests(api)
        XCTAssertEqual(sent, [.assign(faceId: 1, target: .person(7))])
    }
}

@MainActor
final class LoupeFaceBoxesStoreTests: XCTestCase {
    func testBoxesLoadOnlyWhileShowingAndAreCached() async {
        let api = TestAPI()
        await api.setPeople([], faces: [5: [TestModels.face(id: 1, x: 0.25)]])
        let store = LoupeFaceBoxesStore(api: api)
        let photo = PhotoRecord(dto: TestModels.photo(id: 5), apiBaseURL: api.baseURL)

        await store.load(photo)
        XCTAssertTrue(store.boxesByPhoto.isEmpty, "Nothing loads while the overlay is off")

        await store.setShowing(true, photo: photo)
        XCTAssertEqual(store.visibleBoxes[5]?.map(\.x), [0.25])
        XCTAssertEqual(store.faceCount(photoID: 5), 1)

        await store.setShowing(false, photo: photo)
        XCTAssertTrue(store.visibleBoxes.isEmpty)
        await store.setShowing(true, photo: photo)
        let requests = await api.recordedPeopleRequests()
        XCTAssertEqual(requests, [.faces(photoId: 5)])
    }

    func testFailureIsRecordedAndRetried() async {
        let api = TestAPI()
        await api.setPeopleFailure(.faces, .transport("Offline"))
        let store = LoupeFaceBoxesStore(api: api)
        let photo = PhotoRecord(dto: TestModels.photo(id: 5), apiBaseURL: api.baseURL)
        await store.setShowing(true, photo: photo)
        XCTAssertEqual(store.failedPhotoIDs, [5])
        XCTAssertNil(store.faceCount(photoID: 5))

        await api.setPeopleFailure(.faces, nil)
        await store.load(photo)
        XCTAssertEqual(store.failedPhotoIDs, [])
        XCTAssertEqual(store.faceCount(photoID: 5), 0)
    }
}

@MainActor
final class PersonScopeTests: XCTestCase {
    func testPersonScopeListsPhotosByPersonID() async {
        let api = TestAPI()
        let detail = LibraryStore(api: api, scope: .person(7))
        await detail.load()
        let queries = await api.recordedPhotoQueries()
        XCTAssertEqual(queries, [PhotoQuery(personId: 7)])
        XCTAssertEqual(queries.first?.queryItems, [
            URLQueryItem(name: "filterRaw", value: "all"),
            URLQueryItem(name: "personId", value: "7"),
        ])
    }

    func testPersonScopeSourceKeepsFilters() {
        let source = PhotoListingSource(scope: .person(7), filters: LibraryFilters(mediaKind: .raw))
        XCTAssertEqual(source, .photos(PhotoQuery(filterRaw: .raw, personId: 7)))
    }

    func testOtherScopesOmitPersonID() {
        XCTAssertEqual(
            PhotoListingSource(scope: .library, filters: LibraryFilters()),
            .photos(PhotoQuery())
        )
        XCTAssertEqual(
            PhotoListingSource(scope: .collection(3), filters: LibraryFilters()),
            .photos(PhotoQuery(collectionId: 3))
        )
    }

    func testPersonScopesCompareByID() {
        XCTAssertEqual(LibraryScope.person(7), .person(7))
        XCTAssertNotEqual(LibraryScope.person(7), .person(8))
        XCTAssertNotEqual(LibraryScope.person(7), .collection(7))
    }
}

final class PersonLabelTests: XCTestCase {
    func testNamedAccessibilityLabel() {
        let person = TestModels.person(id: 1, name: "Ada", photoCount: 12)
        XCTAssertEqual(PersonLabel.accessibilityLabel(person), "Ada, 12 photos")
    }

    func testUnnamedAccessibilityLabel() {
        let person = TestModels.person(id: 1, photoCount: 3)
        XCTAssertEqual(PersonLabel.accessibilityLabel(person), "Unnamed person, 3 photos")
    }

    func testDisplayNameAndInitial() {
        XCTAssertEqual(PersonLabel.displayName(TestModels.person(id: 1)), "Add a name")
        XCTAssertEqual(PersonLabel.displayName(TestModels.person(id: 1, name: "Ada")), "Ada")
        XCTAssertEqual(PersonLabel.initial("éva"), "É")
        XCTAssertNil(PersonLabel.initial(nil))
        XCTAssertEqual(PersonLabel.photoCountText(1), "1 Photo")
        XCTAssertEqual(PersonLabel.photoCountText(2), "2 Photos")
    }

    func testFaceLabels() {
        let named = TestModels.face(id: 1, personId: 7, personName: "Ada")
        let unnamed = TestModels.face(id: 2, personId: 8)
        let ungrouped = TestModels.face(id: 3)
        let rejected = TestModels.face(id: 4, assignment: .rejected)
        XCTAssertEqual(PersonLabel.faceTitle(named), "Ada")
        XCTAssertEqual(PersonLabel.faceTitle(unnamed), "Add a name")
        XCTAssertEqual(PersonLabel.faceTitle(ungrouped), "Unknown")
        XCTAssertNil(PersonLabel.faceDetail(named))
        XCTAssertEqual(PersonLabel.faceDetail(ungrouped), "Not grouped yet")
        XCTAssertEqual(PersonLabel.faceDetail(rejected), "Removed from people")
        XCTAssertEqual(PersonLabel.faceAccessibilityLabel(named, index: 0, count: 2), "Ada, face 1 of 2")
        XCTAssertEqual(PersonLabel.faceAccessibilityLabel(unnamed, index: 1, count: 2), "Unnamed person, face 2 of 2")
        XCTAssertEqual(
            PersonLabel.faceAccessibilityLabel(rejected, index: 0, count: 1),
            "Unknown person, removed from people, face 1 of 1"
        )
    }
}

final class FaceGeometryTests: XCTestCase {
    private func assertRect(
        _ actual: CGRect,
        _ expected: CGRect,
        file: StaticString = #filePath,
        line: UInt = #line
    ) {
        XCTAssertEqual(actual.minX, expected.minX, accuracy: 0.001, "minX", file: file, line: line)
        XCTAssertEqual(actual.minY, expected.minY, accuracy: 0.001, "minY", file: file, line: line)
        XCTAssertEqual(actual.width, expected.width, accuracy: 0.001, "width", file: file, line: line)
        XCTAssertEqual(actual.height, expected.height, accuracy: 0.001, "height", file: file, line: line)
    }

    func testLandscapeImageInPortraitViewIsLetterboxed() {
        let fit = FaceGeometry.aspectFitRect(
            imageSize: CGSize(width: 4_000, height: 3_000),
            in: CGSize(width: 400, height: 800)
        )
        assertRect(fit, CGRect(x: 0, y: 250, width: 400, height: 300))

        let face = FaceGeometry.rect(
            for: FaceBoxDTO(x: 0.25, y: 0.5, width: 0.25, height: 0.2),
            imageSize: CGSize(width: 4_000, height: 3_000),
            in: CGSize(width: 400, height: 800)
        )
        assertRect(face, CGRect(x: 100, y: 400, width: 100, height: 60))
    }

    func testPortraitImageInLandscapeViewIsPillarboxed() {
        let fit = FaceGeometry.aspectFitRect(
            imageSize: CGSize(width: 3_000, height: 4_000),
            in: CGSize(width: 800, height: 400)
        )
        assertRect(fit, CGRect(x: 250, y: 0, width: 300, height: 400))

        let face = FaceGeometry.rect(
            for: FaceBoxDTO(x: 0.5, y: 0.25, width: 0.2, height: 0.25),
            imageSize: CGSize(width: 3_000, height: 4_000),
            in: CGSize(width: 800, height: 400)
        )
        assertRect(face, CGRect(x: 400, y: 100, width: 60, height: 100))
    }

    func testPortraitImageInPortraitViewFillsWidth() {
        let fit = FaceGeometry.aspectFitRect(
            imageSize: CGSize(width: 3_000, height: 4_000),
            in: CGSize(width: 393, height: 852)
        )
        XCTAssertEqual(fit.width, 393, accuracy: 0.001)
        XCTAssertEqual(fit.height, 524, accuracy: 0.001)
        XCTAssertEqual(fit.minY, 164, accuracy: 0.001)
    }

    func testUnzoomedTransformMatchesBaseRect() {
        let box = FaceBoxDTO(x: 0.25, y: 0.5, width: 0.25, height: 0.2)
        let size = CGSize(width: 4_000, height: 3_000)
        let view = CGSize(width: 400, height: 800)
        assertRect(
            FaceGeometry.rect(for: box, imageSize: size, in: view, zoomScale: 1, contentOffset: .zero),
            FaceGeometry.rect(for: box, imageSize: size, in: view)
        )
    }

    func testBoxesScaleWithZoomAndShiftWithPan() {
        let face = FaceGeometry.rect(
            for: FaceBoxDTO(x: 0.25, y: 0.5, width: 0.25, height: 0.2),
            imageSize: CGSize(width: 4_000, height: 3_000),
            in: CGSize(width: 400, height: 800),
            zoomScale: 2,
            contentOffset: CGPoint(x: 50, y: 100)
        )
        // Base (100, 400, 100x60) doubled, then moved by the pan.
        assertRect(face, CGRect(x: 150, y: 700, width: 200, height: 120))
    }

    func testZoomedBoxCenteredByPanLandsAtViewCenter() {
        let view = CGSize(width: 400, height: 800)
        let box = FaceBoxDTO(x: 0.25, y: 0.5, width: 0.25, height: 0.2)
        // Unzoomed face center: (150, 430). At 3x it is (450, 1290); center it in the view.
        let offset = CGPoint(x: 450 - view.width / 2, y: 1_290 - view.height / 2)
        let face = FaceGeometry.rect(
            for: box,
            imageSize: CGSize(width: 4_000, height: 3_000),
            in: view,
            zoomScale: 3,
            contentOffset: offset
        )
        XCTAssertEqual(face.midX, view.width / 2, accuracy: 0.001)
        XCTAssertEqual(face.midY, view.height / 2, accuracy: 0.001)
        XCTAssertEqual(face.width, 300, accuracy: 0.001)
    }

    func testBoxesAreClampedToTheImage() {
        let face = FaceGeometry.rect(
            for: FaceBoxDTO(x: 0.9, y: 0.0, width: 0.3, height: 0.2),
            imageSize: CGSize(width: 4_000, height: 3_000),
            in: CGSize(width: 400, height: 800)
        )
        assertRect(face, CGRect(x: 360, y: 250, width: 40, height: 60))
    }

    func testDegenerateSizesProduceNoRect() {
        XCTAssertEqual(FaceGeometry.aspectFitRect(imageSize: .zero, in: CGSize(width: 400, height: 800)), .zero)
        XCTAssertEqual(
            FaceGeometry.rect(
                for: FaceBoxDTO(x: 0.1, y: 0.1, width: 0.2, height: 0.2),
                imageSize: CGSize(width: 4_000, height: 3_000),
                in: .zero,
                zoomScale: 2,
                contentOffset: .zero
            ),
            .zero
        )
    }
}

@MainActor
private func waitUntil(
    timeout: Duration = .seconds(3),
    file: StaticString = #filePath,
    line: UInt = #line,
    _ condition: @MainActor () async -> Bool
) async throws {
    let deadline = ContinuousClock.now + timeout
    while !(await condition()) {
        guard ContinuousClock.now < deadline else {
            XCTFail("Condition not met before timeout", file: file, line: line)
            return
        }
        try await Task.sleep(for: .milliseconds(10))
    }
}
