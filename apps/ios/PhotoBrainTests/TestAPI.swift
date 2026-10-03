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

    struct CurationRequest: Equatable, Sendable {
        let id: Int
        let rating: Int?
        let flag: PhotoFlag??
    }

    func setPhotos(_ response: PhotosResponseDTO, failing: Bool = false) {
        photosResponse = response
        shouldFailPhotos = failing
    }

    func setPhotoFailure(_ failing: Bool) {
        shouldFailPhotos = failing
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
        flag: PhotoFlag? = nil
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
            flag: flag
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
