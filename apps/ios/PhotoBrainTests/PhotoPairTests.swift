import XCTest
@testable import PhotoBrain

final class PhotoPairBadgeTests: XCTestCase {
    private let base = URL(string: "https://photos.example.invalid")!

    private func record(_ dto: PhotoDTO) -> PhotoRecord {
        PhotoRecord(dto: dto, apiBaseURL: base)
    }

    func testStandaloneRawKeepsFormatBadge() {
        let raw = record(TestModels.photo(id: 1, name: "DSC_0001.ARW", isRaw: true, rawFormat: "ARW"))
        XCTAssertEqual(raw.formatBadge, "ARW")
        XCTAssertEqual(raw.accessibilityName, "DSC_0001.ARW, RAW photo")
    }

    func testStandaloneRawWithoutFormatFallsBackToRAW() {
        XCTAssertEqual(record(TestModels.photo(id: 1, name: "a.dng", isRaw: true)).formatBadge, "RAW")
        XCTAssertEqual(record(TestModels.photo(id: 1, name: "a.dng", isRaw: true, rawFormat: "")).formatBadge, "RAW")
    }

    func testUnpairedStandardPhotoHasNoBadge() {
        let jpeg = record(TestModels.photo(id: 1, name: "DSC_0001.JPG"))
        XCTAssertNil(jpeg.formatBadge)
        XCTAssertEqual(jpeg.accessibilityName, "DSC_0001.JPG")
    }

    func testStandardPrimaryShowsRawThenOwnExtension() {
        let jpeg = record(TestModels.photo(id: 1, name: "DSC_0001.jpg", pairedPhotoId: 2, pairedFormat: "ARW"))
        XCTAssertEqual(jpeg.formatBadge, "ARW+JPG")
        XCTAssertEqual(jpeg.accessibilityName, "DSC_0001.jpg, ARW plus JPG pair")
    }

    func testRawShownAloneWithStandardPartner() {
        let raw = record(TestModels.photo(
            id: 2,
            name: "DSC_0001.ARW",
            isRaw: true,
            rawFormat: "ARW",
            pairedPhotoId: 1,
            pairedFormat: "JPG"
        ))
        XCTAssertEqual(raw.formatBadge, "ARW+JPG")
        XCTAssertEqual(raw.accessibilityName, "DSC_0001.ARW, ARW plus JPG pair")
    }

    func testHeicPartner() {
        let heic = record(TestModels.photo(id: 1, name: "IMG_0001.HEIC", pairedPhotoId: 2, pairedFormat: "DNG"))
        XCTAssertEqual(heic.formatBadge, "DNG+HEIC")
        let raw = record(TestModels.photo(
            id: 2,
            name: "IMG_0001.DNG",
            isRaw: true,
            rawFormat: "DNG",
            pairedPhotoId: 1,
            pairedFormat: "HEIC"
        ))
        XCTAssertEqual(raw.formatBadge, "DNG+HEIC")
    }

    func testPairedRawWithoutFormatFallsBackToRAW() {
        let raw = record(TestModels.photo(id: 2, name: "x.orf", isRaw: true, pairedPhotoId: 1, pairedFormat: "JPG"))
        XCTAssertEqual(raw.formatBadge, "RAW+JPG")
        XCTAssertEqual(raw.accessibilityName, "x.orf, RAW plus JPG pair")
    }

    func testPairFieldChangesReconfigureGridCell() {
        let unpaired = record(TestModels.photo(id: 1, name: "DSC_0001.JPG"))
        let paired = record(TestModels.photo(id: 1, name: "DSC_0001.JPG", pairedPhotoId: 2, pairedFormat: "ARW"))
        let otherFormat = record(TestModels.photo(id: 1, name: "DSC_0001.JPG", pairedPhotoId: 2, pairedFormat: "CR3"))
        XCTAssertTrue(LibraryGridDiff.rendersDifferently(unpaired, paired))
        XCTAssertTrue(LibraryGridDiff.rendersDifferently(paired, otherFormat))
        XCTAssertFalse(LibraryGridDiff.rendersDifferently(paired, paired))
        XCTAssertEqual(
            LibraryGridDiff.reconfigureIDs(previous: [1: unpaired], next: [1: paired], changedSelectionIDs: []),
            [1]
        )
    }
}

@MainActor
final class PhotoPairStoreTests: XCTestCase {
    private let base = URL(string: "https://photos.example.invalid")!

    func testLoadsPartnerFilenameAndFormatThroughPhotoDetail() async {
        let api = TestAPI()
        let raw = TestModels.photo(id: 2, name: "DSC_0001.ARW", isRaw: true, rawFormat: "ARW", pairedPhotoId: 1, pairedFormat: "JPG")
        let jpeg = TestModels.photo(id: 1, name: "DSC_0001.JPG", pairedPhotoId: 2, pairedFormat: "ARW")
        await api.setPhotos(PhotosResponseDTO(photos: [jpeg, raw], total: 2, rawCount: 1))

        let store = PhotoPairStore(photo: PhotoRecord(dto: jpeg, apiBaseURL: base), api: api)
        await store.load()

        XCTAssertEqual(store.partner, PhotoPairStore.Partner(id: 2, filename: "DSC_0001.ARW", format: "ARW"))
    }

    func testFailedLookupShowsNothing() async {
        let api = TestAPI()
        let jpeg = TestModels.photo(id: 1, name: "DSC_0001.JPG", pairedPhotoId: 99, pairedFormat: "ARW")
        await api.setPhotos(PhotosResponseDTO(photos: [jpeg], total: 1, rawCount: 1))

        let store = PhotoPairStore(photo: PhotoRecord(dto: jpeg, apiBaseURL: base), api: api)
        await store.load()

        XCTAssertNil(store.partner)
    }

    func testUnpairedPhotoMakesNoRequestAndShowsNothing() async {
        let api = TestAPI()
        let store = PhotoPairStore(photo: PhotoRecord(dto: TestModels.photo(id: 1), apiBaseURL: base), api: api)
        await store.load()
        XCTAssertNil(store.partner)
        XCTAssertNil(store.partnerID)
    }

    func testPartnerFormatIsDerivedWhenServerOmitsIt() {
        XCTAssertEqual(PhotoPairStore.format(of: TestModels.photo(id: 1, name: "a.heic")), "HEIC")
        XCTAssertEqual(PhotoPairStore.format(of: TestModels.photo(id: 1, name: "a.nef", isRaw: true, rawFormat: "NEF")), "NEF")
        XCTAssertEqual(PhotoPairStore.format(of: TestModels.photo(id: 1, name: "a.nef", isRaw: true)), "RAW")
    }
}

@MainActor
final class PhotoPairCurationTests: XCTestCase {
    func testAdoptingFlagForUnloadedPartnerIsHarmless() async throws {
        let api = TestAPI()
        await api.setPhotos(PhotosResponseDTO(
            photos: [TestModels.photo(id: 1, rating: 3), TestModels.photo(id: 2)],
            total: 2,
            rawCount: 0
        ))
        let curation = PhotoCurationCenter(api: api)
        let library = LibraryStore(api: api, curation: curation)
        await library.load()
        let revision = library.presentationRevision

        // Server `updated` lists 1 plus its partner 51, which no store has loaded.
        curation.adoptConfirmed(flag: .reject, ids: [1, 51])

        XCTAssertEqual(Set(library.records.map(\.id)), [1, 2])
        let first = try XCTUnwrap(library.records.first { $0.id == 1 })
        XCTAssertEqual(first.flag, .reject)
        XCTAssertEqual(first.rating, 3, "Adopting a flag keeps the loaded rating")
        XCTAssertNil(library.records.first { $0.id == 2 }?.flag)
        XCTAssertGreaterThan(library.presentationRevision, revision)
        XCTAssertNil(curation.errorMessage)
        let patches = await api.recordedCurationRequests()
        XCTAssertTrue(patches.isEmpty)

        // The unknown id leaves no pending state: a later reload is not overlaid for it.
        XCTAssertEqual(curation.overlay([PhotoRecord(dto: TestModels.photo(id: 51), apiBaseURL: api.baseURL)]).first?.flag, nil)
    }
}
