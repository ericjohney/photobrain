import Foundation
@testable import PhotoBrain

actor TestAPI: PhotoBrainAPI {
    nonisolated let baseURL = URL(string: "https://photos.example.invalid")!
    var photosResponse = PhotosResponseDTO(photos: [], total: 0, rawCount: 0)
    var filterResponse = FilterOptionsDTO(cameras: [], lenses: [], isos: [], dates: [])
    var activeResponse = ActiveScansResponseDTO(jobs: [])
    var scans: [String: ScanDTO] = [:]
    var shouldFailPhotos = false
    var searchDelays: [SearchKey: Duration] = [:]
    var searchResponses: [SearchKey: SearchResponseDTO] = [:]
    var searchRequests: [SearchKey] = []
    var startResponse = StartScanResponseDTO(
        success: true,
        jobId: "00000000-0000-0000-0000-000000000001"
    )
    var activeCallCount = 0
    var shouldFailStart = false
    var startForces: [Bool] = []
    var similarResponses: [Int: Result<SimilarPhotosResponseDTO, PhotoBrainAPIError>] = [:]
    var similarDelays: [Int: Duration] = [:]
    var similarRequests: [(id: Int, limit: Int)] = []
    var curationRequests: [CurationRequest] = []
    var curationDelay: Duration = .zero
    var curationFailure: PhotoBrainAPIError?
    /// Server-side curation state; PATCHes apply onto it and responses echo it.
    var curationState: [Int: PhotoCuration] = [:]
    var photoQueries: [PhotoQuery] = []
    /// Server-side collections, kept sorted by name like the real list route.
    var collectionList: [CollectionDTO] = []
    /// Server-side membership: collection id -> photo ids.
    var collectionMembers: [Int: Set<Int>] = [:]
    var collectionFailures: [CollectionRoute: PhotoBrainAPIError] = [:]
    var collectionDelay: Duration = .zero
    var collectionRequests: [CollectionRequest] = []
    /// Server-side auto tags by photo id; photos without an entry are unknown (404).
    var photoTagResults: [Int: Result<PhotoTagsResponseDTO, PhotoBrainAPIError>] = [:]
    var photoTagRequests: [Int] = []
    /// Server-side junk candidates, newest first; `junkReview` filters and pages over them.
    var junkCandidates: [PhotoDTO] = []
    /// Scripted responses returned (in order) before falling back to `junkCandidates`.
    var junkScript: [JunkReviewResponseDTO] = []
    var junkReviewRequests: [JunkReviewRequest] = []
    var junkReviewFailure: PhotoBrainAPIError?
    /// Delay applied to `junkReview` requests by reason filter (`nil` = All).
    var junkReviewDelays: [JunkReason?: Duration] = [:]
    var resolveRequests: [ResolveRequest] = []
    var resolveDelay: Duration = .zero
    var resolveFailure: PhotoBrainAPIError?
    /// Server-side decisions by photo id.
    var resolvedJunk: [Int: JunkAction] = [:]
    private var nextCollectionID = 1

    enum CollectionRoute: Hashable, Sendable {
        case list, create, rename, delete, add, remove, forPhoto
    }

    enum CollectionRequest: Equatable, Sendable {
        case list
        case create(name: String, photoIds: [Int]?)
        case rename(id: Int, name: String)
        case delete(id: Int)
        case add(id: Int, photoIds: [Int])
        case remove(id: Int, photoIds: [Int])
        case forPhoto(id: Int)
    }

    struct CurationRequest: Equatable, Sendable {
        let id: Int
        let rating: Int?
        let flag: PhotoFlag??
    }

    struct JunkReviewRequest: Equatable, Sendable {
        let reason: JunkReason?
        let limit: Int
        let cursor: Int?
    }

    struct ResolveRequest: Equatable, Sendable {
        let ids: [Int]
        let action: JunkAction
    }

    func setJunkCandidates(_ photos: [PhotoDTO]) {
        junkCandidates = photos
    }

    func scriptJunkResponses(_ responses: [JunkReviewResponseDTO]) {
        junkScript = responses
    }

    func setJunkReviewFailure(_ failure: PhotoBrainAPIError?) {
        junkReviewFailure = failure
    }

    func setJunkReviewDelay(_ delay: Duration, for reason: JunkReason?) {
        junkReviewDelays[reason] = delay
    }

    func setResolve(delay: Duration = .zero, failure: PhotoBrainAPIError? = nil) {
        resolveDelay = delay
        resolveFailure = failure
    }

    func recordedJunkReviewRequests() -> [JunkReviewRequest] {
        junkReviewRequests
    }

    func recordedResolveRequests() -> [ResolveRequest] {
        resolveRequests
    }

    func serverResolvedJunk() -> [Int: JunkAction] {
        resolvedJunk
    }

    func setPhotos(_ response: PhotosResponseDTO, failing: Bool = false) {
        photosResponse = response
        shouldFailPhotos = failing
    }

    func setPhotoFailure(_ failing: Bool) {
        shouldFailPhotos = failing
    }

    func setFilterOptions(_ options: FilterOptionsDTO) {
        filterResponse = options
    }

    func setPhotoTags(id: Int, _ result: Result<PhotoTagsResponseDTO, PhotoBrainAPIError>) {
        photoTagResults[id] = result
    }

    func recordedPhotoTagRequests() -> [Int] {
        photoTagRequests
    }

    struct SearchKey: Hashable, Sendable {
        let query: String
        let filters: PhotoQuery
    }

    func setSearch(
        query: String,
        filters: PhotoQuery = PhotoQuery(),
        delay: Duration,
        response: SearchResponseDTO
    ) {
        let key = SearchKey(query: query, filters: filters)
        searchDelays[key] = delay
        searchResponses[key] = response
    }

    func recordedSearchRequests() -> [SearchKey] {
        searchRequests
    }

    func setSimilar(
        id: Int,
        delay: Duration = .zero,
        result: Result<SimilarPhotosResponseDTO, PhotoBrainAPIError>
    ) {
        similarDelays[id] = delay
        similarResponses[id] = result
    }

    func recordedSimilarRequests() -> [(id: Int, limit: Int)] {
        similarRequests
    }

    func setActive(_ jobs: [ScanDTO]) {
        activeResponse = ActiveScansResponseDTO(jobs: jobs)
        for job in jobs { scans[job.id] = job }
    }

    func setStartResponse(_ response: StartScanResponseDTO) {
        startResponse = response
    }
    func setStartFailure(_ failing: Bool) {
        shouldFailStart = failing
    }


    func setScan(id: String, response: ScanDTO?) {
        scans[id] = response
    }

    func recordedActiveCallCount() -> Int {
        activeCallCount
    }
    func recordedStartForces() -> [Bool] {
        startForces
    }

    func setCuration(delay: Duration = .zero, failure: PhotoBrainAPIError? = nil) {
        curationDelay = delay
        curationFailure = failure
    }

    func recordedCurationRequests() -> [CurationRequest] {
        curationRequests
    }

    func serverCuration(id: Int) -> PhotoCuration? {
        curationState[id]
    }

    func recordedPhotoQueries() -> [PhotoQuery] {
        photoQueries
    }

    func setCollections(_ collections: [CollectionDTO], members: [Int: Set<Int>] = [:]) {
        collectionList = collections
        collectionMembers = members
        nextCollectionID = (collections.map(\.id).max() ?? 0) + 1
    }

    func setCollectionFailure(_ route: CollectionRoute, _ failure: PhotoBrainAPIError?) {
        collectionFailures[route] = failure
    }

    func setCollectionDelay(_ delay: Duration) {
        collectionDelay = delay
    }

    func recordedCollectionRequests() -> [CollectionRequest] {
        collectionRequests
    }

    func serverMembers(of collectionId: Int) -> Set<Int> {
        collectionMembers[collectionId] ?? []
    }

    func serverCollections() -> [CollectionDTO] {
        collectionList
    }

    func folders() async throws -> FoldersResponseDTO {
        FoldersResponseDTO(folders: [], totalPhotos: photosResponse.total)
    }

    func filterOptions(folder: String?) async throws -> FilterOptionsDTO {
        filterResponse
    }

    func photos(query: PhotoQuery) async throws -> PhotosResponseDTO {
        photoQueries.append(query)
        if shouldFailPhotos { throw URLError(.notConnectedToInternet) }
        return photosResponse
    }

    func photo(id: Int) async throws -> PhotoDTO {
        guard let photo = photosResponse.photos.first(where: { $0.id == id }) else {
            throw PhotoBrainAPIError.server(status: 404, code: "PHOTO_NOT_FOUND", message: "Photo not found")
        }
        return photo
    }

    func search(query: String, limit: Int, filters: PhotoQuery) async throws -> SearchResponseDTO {
        let key = SearchKey(query: query, filters: filters)
        searchRequests.append(key)
        if let delay = searchDelays[key] { try await Task.sleep(for: delay) }
        return searchResponses[key] ?? SearchResponseDTO(photos: [], total: 0, query: query)
    }

    func similarPhotos(id: Int, limit: Int) async throws -> SimilarPhotosResponseDTO {
        similarRequests.append((id, limit))
        if let delay = similarDelays[id], delay > .zero { try await Task.sleep(for: delay) }
        guard let result = similarResponses[id] else {
            throw PhotoBrainAPIError.server(status: 404, code: "PHOTO_NOT_FOUND", message: "Photo not found")
        }
        return try result.get()
    }

    func photoTags(id: Int) async throws -> PhotoTagsResponseDTO {
        photoTagRequests.append(id)
        guard let result = photoTagResults[id] else {
            throw PhotoBrainAPIError.server(status: 404, code: "PHOTO_NOT_FOUND", message: "Photo not found")
        }
        return try result.get()
    }

    func updateCuration(id: Int, rating: Int?, flag: PhotoFlag??) async throws -> PhotoDTO {
        curationRequests.append(CurationRequest(id: id, rating: rating, flag: flag))
        // Outcome is decided when the request is sent, like a real server receiving it.
        let failure = curationFailure
        if curationDelay > .zero { try await Task.sleep(for: curationDelay) }
        if let failure { throw failure }
        let current = curationState[id] ?? PhotoCuration(rating: 0, flag: nil)
        let next = CurationPatch(rating: rating, flag: flag).applied(to: current)
        curationState[id] = next
        return TestModels.photo(id: id, rating: next.rating, flag: next.flag)
    }

    func collections() async throws -> CollectionsResponseDTO {
        try await collectionCall(.list, .list)
        return CollectionsResponseDTO(collections: collectionList)
    }

    func createCollection(name: String, photoIds: [Int]?) async throws -> CollectionDTO {
        try await collectionCall(.create, .create(name: name, photoIds: photoIds))
        try ensureNameAvailable(name, excluding: nil)
        let id = nextCollectionID
        nextCollectionID += 1
        collectionMembers[id] = Set(photoIds ?? [])
        let created = TestModels.collection(id: id, name: name, photoCount: collectionMembers[id]?.count ?? 0)
        collectionList.append(created)
        sortCollections()
        return created
    }

    func renameCollection(id: Int, name: String) async throws -> CollectionDTO {
        try await collectionCall(.rename, .rename(id: id, name: name))
        guard let index = collectionList.firstIndex(where: { $0.id == id }) else { throw Self.collectionNotFound }
        try ensureNameAvailable(name, excluding: id)
        let existing = collectionList[index]
        let renamed = TestModels.collection(id: id, name: name, photoCount: existing.photoCount, cover: existing.cover)
        collectionList[index] = renamed
        sortCollections()
        return renamed
    }

    func deleteCollection(id: Int) async throws {
        try await collectionCall(.delete, .delete(id: id))
        guard collectionList.contains(where: { $0.id == id }) else { throw Self.collectionNotFound }
        collectionList.removeAll { $0.id == id }
        collectionMembers[id] = nil
    }

    func addPhotos(toCollection id: Int, photoIds: [Int]) async throws -> CollectionPhotosAddedDTO {
        try await collectionCall(.add, .add(id: id, photoIds: photoIds))
        guard collectionList.contains(where: { $0.id == id }) else { throw Self.collectionNotFound }
        let before = collectionMembers[id] ?? []
        let after = before.union(photoIds)
        collectionMembers[id] = after
        updateCount(id: id, count: after.count)
        return CollectionPhotosAddedDTO(added: after.count - before.count, photoCount: after.count)
    }

    func removePhotos(fromCollection id: Int, photoIds: [Int]) async throws -> CollectionPhotosRemovedDTO {
        try await collectionCall(.remove, .remove(id: id, photoIds: photoIds))
        guard collectionList.contains(where: { $0.id == id }) else { throw Self.collectionNotFound }
        let before = collectionMembers[id] ?? []
        let after = before.subtracting(photoIds)
        collectionMembers[id] = after
        updateCount(id: id, count: after.count)
        return CollectionPhotosRemovedDTO(removed: before.count - after.count, photoCount: after.count)
    }

    func collectionsForPhoto(id: Int) async throws -> PhotoCollectionsDTO {
        try await collectionCall(.forPhoto, .forPhoto(id: id))
        let ids = collectionMembers.filter { $0.value.contains(id) }.map(\.key).sorted()
        return PhotoCollectionsDTO(collectionIds: ids)
    }

    func junkReview(reason: JunkReason?, limit: Int, cursor: Int?) async throws -> JunkReviewResponseDTO {
        junkReviewRequests.append(JunkReviewRequest(reason: reason, limit: limit, cursor: cursor))
        if let failure = junkReviewFailure { throw failure }
        if let delay = junkReviewDelays[reason] { try await Task.sleep(for: delay) }
        if !junkScript.isEmpty { return junkScript.removeFirst() }
        let matching = junkCandidates.filter { photo in reason.map { photo.junkReasons.contains($0) } ?? true }
        let start = cursor.flatMap { id in matching.firstIndex { $0.id == id }.map { $0 + 1 } } ?? 0
        let page = Array(matching[min(start, matching.count)...].prefix(limit))
        let hasMore = start + page.count < matching.count
        return JunkReviewResponseDTO(
            photos: page,
            nextCursor: hasMore ? page.last?.id : nil,
            counts: Self.junkCounts(junkCandidates)
        )
    }

    func resolveJunk(ids: [Int], action: JunkAction) async throws -> ResolveJunkResponseDTO {
        resolveRequests.append(ResolveRequest(ids: ids, action: action))
        // Outcome is decided when the request arrives, like a real server.
        let failure = resolveFailure
        if resolveDelay > .zero { try await Task.sleep(for: resolveDelay) }
        if let failure { throw failure }
        let known = Set(junkCandidates.map(\.id))
        let updated = ids.filter(known.contains)
        junkCandidates.removeAll { updated.contains($0.id) }
        for id in updated { resolvedJunk[id] = action }
        return ResolveJunkResponseDTO(updated: updated)
    }

    static func junkCounts(_ photos: [PhotoDTO]) -> JunkCountsDTO {
        var counts = JunkCountsDTO.zero
        for photo in photos { counts.adjust(reasons: photo.junkReasons, by: 1) }
        return counts
    }

    static let collectionNotFound = PhotoBrainAPIError.server(
        status: 404,
        code: "COLLECTION_NOT_FOUND",
        message: "Collection not found"
    )

    /// Records the request, then applies the configured delay and failure. Like a real server,
    /// the failure is decided when the request arrives.
    private func collectionCall(_ route: CollectionRoute, _ request: CollectionRequest) async throws {
        collectionRequests.append(request)
        let failure = collectionFailures[route]
        if collectionDelay > .zero { try await Task.sleep(for: collectionDelay) }
        if let failure { throw failure }
    }

    private func ensureNameAvailable(_ name: String, excluding id: Int?) throws {
        let taken = collectionList.contains {
            $0.id != id && $0.name.compare(name, options: .caseInsensitive) == .orderedSame
        }
        if taken {
            throw PhotoBrainAPIError.server(
                status: 409,
                code: "COLLECTION_NAME_TAKEN",
                message: "Collection name already exists"
            )
        }
    }

    private func updateCount(id: Int, count: Int) {
        guard let index = collectionList.firstIndex(where: { $0.id == id }) else { return }
        collectionList[index].photoCount = count
    }

    private func sortCollections() {
        collectionList.sort { $0.name.compare($1.name, options: .caseInsensitive) == .orderedAscending }
    }

    func startScan(force: Bool) async throws -> StartScanResponseDTO {
        startForces.append(force)
        if shouldFailStart { throw URLError(.networkConnectionLost) }
        return startResponse
    }

    func scan(id: String) async throws -> ScanDTO? {
        scans[id]
    }

    func activeScans() async throws -> ActiveScansResponseDTO {
        activeCallCount += 1
        return activeResponse
    }

    nonisolated func cancelAll() {}
}

enum TestModels {
    static func photo(
        id: Int,
        taken: String? = "2024-01-01T12:00:00Z",
        rating: Int = 0,
        flag: PhotoFlag? = nil,
        junkReasons: [JunkReason] = []
    ) -> PhotoDTO {
        PhotoDTO(
            id: id,
            path: "synthetic/photo_\(id).jpg",
            name: "photo_\(id).jpg",
            size: 1_024,
            createdAt: Date(timeIntervalSince1970: 1_700_000_000 + Double(id)),
            modifiedAt: Date(timeIntervalSince1970: 1_700_000_100 + Double(id)),
            width: 4_000,
            height: 3_000,
            mimeType: "image/jpeg",
            isRaw: false,
            rawFormat: nil,
            rawStatus: nil,
            rawError: nil,
            thumbnailStatus: "completed",
            thumbnailUpdatedAt: Date(timeIntervalSince1970: 1_700_000_200 + Double(id)),
            embeddingStatus: "completed",
            phashStatus: "completed",
            exif: PhotoEXIFDTO(
                id: id,
                photoId: id,
                cameraMake: "Synthetic",
                cameraModel: "Camera",
                lensMake: "Synthetic",
                lensModel: "Lens",
                focalLength: 35,
                iso: 100,
                aperture: "f/2.8",
                shutterSpeed: "1/250",
                exposureBias: "+0 EV",
                dateTaken: taken,
                gpsLatitude: nil,
                gpsLongitude: nil,
                gpsAltitude: nil
            ),
            rating: rating,
            flag: flag,
            junkReasons: junkReasons
        )
    }

    static func scan(
        id: String,
        phase: ScanPhase = .processing,
        status: ScanStatus? = nil,
        current: Int = 1,
        updatedAt: Date
    ) -> ScanDTO {
        let resolvedStatus: ScanStatus
        if let status {
            resolvedStatus = status
        } else {
            switch phase {
            case .queued: resolvedStatus = .queued
            case .completed: resolvedStatus = .completed
            case .failed: resolvedStatus = .failed
            case .discovering, .processing, .scanComplete, .embedding: resolvedStatus = .running
            }
        }
        return ScanDTO(
            id: id,
            phase: phase,
            current: current,
            total: 10,
            status: resolvedStatus,
            error: phase == .failed ? "Synthetic failure" : nil,
            createdAt: updatedAt.addingTimeInterval(-10),
            updatedAt: updatedAt
        )
    }

    static func collection(
        id: Int,
        name: String,
        photoCount: Int = 0,
        cover: CollectionCoverDTO? = nil
    ) -> CollectionDTO {
        CollectionDTO(
            id: id,
            name: name,
            photoCount: photoCount,
            cover: cover,
            createdAt: Date(timeIntervalSince1970: 1_700_000_000),
            updatedAt: Date(timeIntervalSince1970: 1_700_000_000 + Double(id))
        )
    }
}

/// Intercepts every request made by an `APIClient` built with `StubURLProtocol.makeClient()`.
final class StubURLProtocol: URLProtocol, @unchecked Sendable {
    static func makeClient() -> APIClient {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [StubURLProtocol.self]
        return APIClient(
            baseURL: URL(string: "https://photos.example.test")!,
            session: URLSession(configuration: configuration)
        )
    }

    /// URLSession moves POST bodies into `httpBodyStream` before a protocol sees them;
    /// recorded requests carry the drained bytes back in `httpBody`.
    private static func body(of request: URLRequest) -> Data? {
        if let body = request.httpBody { return body }
        guard let stream = request.httpBodyStream else { return nil }
        stream.open()
        defer { stream.close() }
        var data = Data()
        var buffer = [UInt8](repeating: 0, count: 4_096)
        while stream.hasBytesAvailable {
            let count = stream.read(&buffer, maxLength: buffer.count)
            guard count > 0 else { break }
            data.append(buffer, count: count)
        }
        return data
    }

    private static let lock = NSLock()
    nonisolated(unsafe) private static var recorded: [URLRequest] = []
    nonisolated(unsafe) private static var response: (status: Int, body: Data) = (500, Data())

    static var requests: [URLRequest] {
        lock.lock()
        defer { lock.unlock() }
        return recorded
    }

    static func respond(status: Int, body: String) {
        lock.lock()
        response = (status, Data(body.utf8))
        lock.unlock()
    }

    static func reset() {
        lock.lock()
        recorded = []
        response = (500, Data())
        lock.unlock()
    }

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        var recordedRequest = request
        recordedRequest.httpBody = Self.body(of: request)
        Self.lock.lock()
        Self.recorded.append(recordedRequest)
        let (status, body) = Self.response
        Self.lock.unlock()
        let http = HTTPURLResponse(
            url: request.url!,
            statusCode: status,
            httpVersion: "HTTP/1.1",
            headerFields: ["Content-Type": "application/json"]
        )!
        client?.urlProtocol(self, didReceive: http, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: body)
        client?.urlProtocolDidFinishLoading(self)
    }

    override func stopLoading() {}
}
