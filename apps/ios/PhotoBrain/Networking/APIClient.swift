import Foundation

struct PhotoQuery: Hashable, Sendable {
    var filterRaw: LibraryFilters.MediaKind = .all
    var folder: String?
    var camera: String?
    var lens: String?
    var iso: Int?
    var dateMonth: String?
    /// Only photos rated at least this many stars (1-5).
    var minRating: Int?
    var flag: PhotoFlagFilter?
    /// Scopes results to one collection's members.
    var collectionId: Int?
    /// Auto tag slug, e.g. `night-sky`.
    var tag: String?
    /// ISO 3166-1 alpha-2 country code of the photo's place, e.g. `JP`.
    var country: String?
    /// GeoNames city id of the photo's place.
    var place: Int?
    /// Only photos with a valid location inside this map region. Never saved in smart albums.
    var bounds: PhotoBounds?
    /// Exact capture date `YYYY-MM-DD` (EXIF wall-clock date). Never saved in smart albums.
    var capturedDate: String?
    /// One auto event's members, by event id. Never saved in smart albums.
    var event: Int?

    /// `GET /photos`, `GET /locations`, and `GET /gear-stats` query items. `filterRaw` is always
    /// sent; the other filters only when set, and the four bounds edges together or not at all.
    var queryItems: [URLQueryItem] {
        var items = [URLQueryItem(name: "filterRaw", value: filterRaw.rawValue)]
        if let folder { items.append(URLQueryItem(name: "folder", value: folder)) }
        if let camera { items.append(URLQueryItem(name: "camera", value: camera)) }
        if let lens { items.append(URLQueryItem(name: "lens", value: lens)) }
        if let iso { items.append(URLQueryItem(name: "iso", value: String(iso))) }
        if let dateMonth { items.append(URLQueryItem(name: "dateMonth", value: dateMonth)) }
        if let minRating { items.append(URLQueryItem(name: "minRating", value: String(minRating))) }
        if let flag { items.append(URLQueryItem(name: "flag", value: flag.rawValue)) }
        if let collectionId { items.append(URLQueryItem(name: "collectionId", value: String(collectionId))) }
        if let tag { items.append(URLQueryItem(name: "tag", value: tag)) }
        if let country { items.append(URLQueryItem(name: "country", value: country)) }
        if let place { items.append(URLQueryItem(name: "place", value: String(place))) }
        if let bounds {
            items.append(URLQueryItem(name: "north", value: String(bounds.north)))
            items.append(URLQueryItem(name: "south", value: String(bounds.south)))
            items.append(URLQueryItem(name: "east", value: String(bounds.east)))
            items.append(URLQueryItem(name: "west", value: String(bounds.west)))
        }
        if let capturedDate { items.append(URLQueryItem(name: "capturedDate", value: capturedDate)) }
        if let event { items.append(URLQueryItem(name: "event", value: String(event))) }
        return items
    }
}

protocol PhotoBrainAPI: Sendable {
    var baseURL: URL { get }
    func folders() async throws -> FoldersResponseDTO
    func filterOptions(folder: String?) async throws -> FilterOptionsDTO
    func photos(query: PhotoQuery) async throws -> PhotosResponseDTO
    /// `GET /locations`: every matching photo with a valid location, ascending by id.
    func locations(query: PhotoQuery) async throws -> LocationsResponseDTO
    func photo(id: Int) async throws -> PhotoDTO
    func search(query: String, limit: Int, filters: PhotoQuery) async throws -> SearchResponseDTO
    /// `GET /photos/{id}/similar`; `event` scopes neighbours to one auto event and is sent only
    /// when set.
    func similarPhotos(id: Int, limit: Int, event: Int?) async throws -> SimilarPhotosResponseDTO
    /// `GET /photos/{id}/tags`: the photo's auto tags, highest score first.
    func photoTags(id: Int) async throws -> PhotoTagsResponseDTO
    /// `GET /photos/{id}/place`: the photo's current place, or `nil` when it has none.
    func photoPlace(id: Int) async throws -> PhotoPlaceResponseDTO
    /// `GET /on-this-day?date=YYYY-MM-DD`: earlier years' photos captured on `date`'s month and
    /// day, where `date` is the device's local calendar date.
    func onThisDay(date: Date) async throws -> OnThisDayResponseDTO
    /// `GET /events?folder=`: auto events newest first; `folder` is sent only when set.
    func events(folder: String?) async throws -> EventsResponseDTO
    /// `GET /gear-stats`: gear usage over exactly the photos `photos(query:)` lists for `query`,
    /// sent with the same query items.
    func gearStats(query: PhotoQuery) async throws -> GearStatsDTO
    /// `PATCH /photos/{id}`. `rating: nil` and `flag: nil` leave a field unchanged;
    /// `flag: .some(nil)` clears the flag. At least one field must be provided.
    func updateCuration(id: Int, rating: Int?, flag: PhotoFlag??) async throws -> PhotoDTO
    func collections() async throws -> CollectionsResponseDTO
    /// `POST /collections`, expects `201`. The name is validated client-side first.
    func createCollection(name: String, photoIds: [Int]?) async throws -> CollectionDTO
    func renameCollection(id: Int, name: String) async throws -> CollectionDTO
    /// `DELETE /collections/{id}`, expects `204` with an empty body. Photos are untouched.
    func deleteCollection(id: Int) async throws
    func addPhotos(toCollection id: Int, photoIds: [Int]) async throws -> CollectionPhotosAddedDTO
    func removePhotos(fromCollection id: Int, photoIds: [Int]) async throws -> CollectionPhotosRemovedDTO
    func collectionsForPhoto(id: Int) async throws -> PhotoCollectionsDTO
    func smartAlbums() async throws -> SmartAlbumsResponseDTO
    /// `POST /smart-albums`, expects `201`. Name, query, and criteria are validated client-side first.
    func createSmartAlbum(name: String, filters: SmartAlbumFilters, query: String?) async throws -> SmartAlbumDTO
    /// `PATCH /smart-albums/{id}` with only the name; filters and query are unchanged.
    func renameSmartAlbum(id: Int, name: String) async throws -> SmartAlbumDTO
    /// `DELETE /smart-albums/{id}`, expects `204`. Photos are untouched.
    func deleteSmartAlbum(id: Int) async throws
    /// `GET /review/junk`. `reason` and `cursor` are sent only when set; `limit` is 1-500.
    func junkReview(reason: JunkReason?, limit: Int, cursor: Int?) async throws -> JunkReviewResponseDTO
    /// `POST /review/junk/resolve` for 1-500 positive photo ids.
    func resolveJunk(ids: [Int], action: JunkAction) async throws -> ResolveJunkResponseDTO
    /// `GET /duplicates`. `kind` and `cursor` are sent only when set; `limit` is 1-200.
    func duplicateGroups(kind: DuplicateKind?, limit: Int, cursor: String?) async throws -> DuplicateGroupsResponseDTO
    /// `POST /duplicates/resolve`. A stale key throws `PhotoBrainAPIError.duplicateGroupChanged`.
    func resolveDuplicateGroup(key: String, resolution: DuplicateResolution) async throws -> ResolveDuplicateGroupResponseDTO
    func startScan(force: Bool) async throws -> StartScanResponseDTO
    func scan(id: String) async throws -> ScanDTO?
    func activeScans() async throws -> ActiveScansResponseDTO
    func cancelAll()
}

final class APIClient: @unchecked Sendable, PhotoBrainAPI {
    let baseURL: URL

    private let session: URLSession
    private let decoder: JSONDecoder
    private let encoder: JSONEncoder
    private let lock = NSLock()
    private var tasks: [UUID: Task<(Data, URLResponse), Error>] = [:]
    private let maximumJSONBytes = 16 * 1_024 * 1_024

    init(baseURL: URL, session: URLSession? = nil) {
        self.baseURL = baseURL
        if let session {
            self.session = session
        } else {
            let configuration = URLSessionConfiguration.default
            configuration.waitsForConnectivity = true
            configuration.timeoutIntervalForRequest = 15
            configuration.timeoutIntervalForResource = 30
            configuration.requestCachePolicy = .reloadRevalidatingCacheData
            self.session = URLSession(configuration: configuration)
        }
        decoder = APIModelCoding.decoder()
        encoder = APIModelCoding.encoder()
    }

    func folders() async throws -> FoldersResponseDTO {
        try await get(path: ["folders"])
    }

    func filterOptions(folder: String?) async throws -> FilterOptionsDTO {
        try await get(
            path: ["filter-options"],
            queryItems: folder.map { [URLQueryItem(name: "folder", value: $0)] } ?? []
        )
    }

    func photos(query: PhotoQuery) async throws -> PhotosResponseDTO {
        try await get(path: ["photos"], queryItems: query.queryItems)
    }

    func locations(query: PhotoQuery) async throws -> LocationsResponseDTO {
        try await get(path: ["locations"], queryItems: query.queryItems)
    }

    func photo(id: Int) async throws -> PhotoDTO {
        guard id > 0 else { throw PhotoBrainAPIError.invalidRequest }
        return try await get(path: ["photos", String(id)])
    }

    func search(query: String, limit: Int = 50, filters: PhotoQuery = PhotoQuery()) async throws -> SearchResponseDTO {
        let trimmed = query.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty, (1...100).contains(limit) else {
            throw PhotoBrainAPIError.invalidRequest
        }
        return try await post(
            path: ["search"],
            body: SearchRequestDTO(query: trimmed, limit: limit, filters: filters)
        )
    }

    func similarPhotos(id: Int, limit: Int = 30, event: Int? = nil) async throws -> SimilarPhotosResponseDTO {
        guard id > 0, (1...100).contains(limit) else { throw PhotoBrainAPIError.invalidRequest }
        var items = [URLQueryItem(name: "limit", value: String(limit))]
        if let event { items.append(URLQueryItem(name: "event", value: String(event))) }
        return try await get(path: ["photos", String(id), "similar"], queryItems: items)
    }

    func photoTags(id: Int) async throws -> PhotoTagsResponseDTO {
        guard id > 0 else { throw PhotoBrainAPIError.invalidRequest }
        return try await get(path: ["photos", String(id), "tags"])
    }

    func photoPlace(id: Int) async throws -> PhotoPlaceResponseDTO {
        guard id > 0 else { throw PhotoBrainAPIError.invalidRequest }
        return try await get(path: ["photos", String(id), "place"])
    }

    func onThisDay(date: Date) async throws -> OnThisDayResponseDTO {
        try await get(
            path: ["on-this-day"],
            queryItems: [URLQueryItem(name: "date", value: OnThisDayDate.localDayString(date))]
        )
    }

    func events(folder: String?) async throws -> EventsResponseDTO {
        try await get(
            path: ["events"],
            queryItems: folder.map { [URLQueryItem(name: "folder", value: $0)] } ?? []
        )
    }

    func gearStats(query: PhotoQuery) async throws -> GearStatsDTO {
        try await get(path: ["gear-stats"], queryItems: query.queryItems)
    }

    func updateCuration(id: Int, rating: Int?, flag: PhotoFlag??) async throws -> PhotoDTO {
        guard id > 0, rating != nil || flag != nil else { throw PhotoBrainAPIError.invalidRequest }
        if let rating, !(0...5).contains(rating) { throw PhotoBrainAPIError.invalidRequest }
        return try await send(
            method: "PATCH",
            path: ["photos", String(id)],
            body: CurationPatchDTO(rating: rating, flag: flag)
        )
    }

    func collections() async throws -> CollectionsResponseDTO {
        try await get(path: ["collections"])
    }

    func createCollection(name: String, photoIds: [Int]?) async throws -> CollectionDTO {
        let name = try CollectionName.validated(name)
        if let photoIds { try Self.validatePhotoBatch(photoIds, allowEmpty: true) }
        return try await send(
            method: "POST",
            path: ["collections"],
            body: CreateCollectionRequestDTO(name: name, photoIds: photoIds),
            expectedStatus: 201
        )
    }

    func renameCollection(id: Int, name: String) async throws -> CollectionDTO {
        let name = try CollectionName.validated(name)
        guard id > 0 else { throw PhotoBrainAPIError.invalidRequest }
        return try await send(
            method: "PATCH",
            path: ["collections", String(id)],
            body: RenameCollectionRequestDTO(name: name)
        )
    }

    func deleteCollection(id: Int) async throws {
        guard id > 0 else { throw PhotoBrainAPIError.invalidRequest }
        var request = try request(path: ["collections", String(id)])
        request.httpMethod = "DELETE"
        _ = try await transfer(request, expectedStatus: 204)
    }

    func addPhotos(toCollection id: Int, photoIds: [Int]) async throws -> CollectionPhotosAddedDTO {
        guard id > 0 else { throw PhotoBrainAPIError.invalidRequest }
        try Self.validatePhotoBatch(photoIds, allowEmpty: false)
        return try await post(
            path: ["collections", String(id), "photos"],
            body: CollectionPhotosRequestDTO(photoIds: photoIds)
        )
    }

    func removePhotos(fromCollection id: Int, photoIds: [Int]) async throws -> CollectionPhotosRemovedDTO {
        guard id > 0 else { throw PhotoBrainAPIError.invalidRequest }
        try Self.validatePhotoBatch(photoIds, allowEmpty: false)
        return try await post(
            path: ["collections", String(id), "photos", "remove"],
            body: CollectionPhotosRequestDTO(photoIds: photoIds)
        )
    }

    func collectionsForPhoto(id: Int) async throws -> PhotoCollectionsDTO {
        guard id > 0 else { throw PhotoBrainAPIError.invalidRequest }
        return try await get(path: ["photos", String(id), "collections"])
    }

    func smartAlbums() async throws -> SmartAlbumsResponseDTO {
        try await get(path: ["smart-albums"])
    }

    func createSmartAlbum(name: String, filters: SmartAlbumFilters, query: String?) async throws -> SmartAlbumDTO {
        let body = try SmartAlbumDraft.validated(name: name, filters: filters, query: query)
        return try await send(method: "POST", path: ["smart-albums"], body: body, expectedStatus: 201)
    }

    func renameSmartAlbum(id: Int, name: String) async throws -> SmartAlbumDTO {
        let name = try SmartAlbumDraft.validatedName(name)
        guard id > 0 else { throw PhotoBrainAPIError.invalidRequest }
        return try await send(
            method: "PATCH",
            path: ["smart-albums", String(id)],
            body: RenameSmartAlbumRequestDTO(name: name)
        )
    }

    func deleteSmartAlbum(id: Int) async throws {
        guard id > 0 else { throw PhotoBrainAPIError.invalidRequest }
        var request = try request(path: ["smart-albums", String(id)])
        request.httpMethod = "DELETE"
        _ = try await transfer(request, expectedStatus: 204)
    }

    func junkReview(reason: JunkReason?, limit: Int, cursor: Int?) async throws -> JunkReviewResponseDTO {
        guard (1...JunkReviewResponseDTO.maximumLimit).contains(limit) else { throw PhotoBrainAPIError.invalidRequest }
        if let cursor, cursor <= 0 { throw PhotoBrainAPIError.invalidRequest }
        var items: [URLQueryItem] = []
        if let reason { items.append(URLQueryItem(name: "reason", value: reason.rawValue)) }
        items.append(URLQueryItem(name: "limit", value: String(limit)))
        if let cursor { items.append(URLQueryItem(name: "cursor", value: String(cursor))) }
        return try await get(path: ["review", "junk"], queryItems: items)
    }

    func resolveJunk(ids: [Int], action: JunkAction) async throws -> ResolveJunkResponseDTO {
        try Self.validatePhotoBatch(ids, allowEmpty: false)
        return try await post(
            path: ["review", "junk", "resolve"],
            body: ResolveJunkRequestDTO(photoIds: ids, action: action)
        )
    }

    func duplicateGroups(kind: DuplicateKind?, limit: Int, cursor: String?) async throws -> DuplicateGroupsResponseDTO {
        guard (1...DuplicateGroupsResponseDTO.maximumLimit).contains(limit) else { throw PhotoBrainAPIError.invalidRequest }
        if let cursor, cursor.isEmpty { throw PhotoBrainAPIError.invalidRequest }
        var items: [URLQueryItem] = []
        if let kind { items.append(URLQueryItem(name: "kind", value: kind.rawValue)) }
        items.append(URLQueryItem(name: "limit", value: String(limit)))
        if let cursor { items.append(URLQueryItem(name: "cursor", value: cursor)) }
        return try await get(path: ["duplicates"], queryItems: items)
    }

    func resolveDuplicateGroup(key: String, resolution: DuplicateResolution) async throws -> ResolveDuplicateGroupResponseDTO {
        guard !key.isEmpty else { throw PhotoBrainAPIError.invalidRequest }
        if case let .keep(ids) = resolution { try Self.validatePhotoBatch(ids, allowEmpty: false) }
        do {
            return try await post(
                path: ["duplicates", "resolve"],
                body: ResolveDuplicateGroupRequestDTO(key: key, resolution: resolution)
            )
        } catch PhotoBrainAPIError.server(status: 409, code: "DUPLICATE_GROUP_CHANGED", _) {
            throw PhotoBrainAPIError.duplicateGroupChanged
        }
    }

    private static func validatePhotoBatch(_ ids: [Int], allowEmpty: Bool) throws {
        guard (allowEmpty || !ids.isEmpty),
              ids.count <= CollectionName.maximumPhotoBatch,
              ids.allSatisfy({ $0 > 0 }) else {
            throw PhotoBrainAPIError.invalidRequest
        }
    }

    func startScan(force: Bool) async throws -> StartScanResponseDTO {
        try await post(path: ["scans"], body: StartScanRequestDTO(force: force))
    }

    func scan(id: String) async throws -> ScanDTO? {
        guard UUID(uuidString: id) != nil else { throw PhotoBrainAPIError.invalidRequest }
        return try await get(path: ["scans", id])
    }

    func activeScans() async throws -> ActiveScansResponseDTO {
        try await get(path: ["scans", "active"])
    }

    func cancelAll() {
        lock.lock()
        let running = Array(tasks.values)
        tasks.removeAll()
        lock.unlock()
        running.forEach { $0.cancel() }
    }

    private func get<Response: Decodable>(
        path: [String],
        queryItems: [URLQueryItem] = []
    ) async throws -> Response {
        var request = try request(path: path, queryItems: queryItems)
        request.httpMethod = "GET"
        return try await perform(request)
    }

    private func post<Body: Encodable, Response: Decodable>(
        path: [String],
        body: Body
    ) async throws -> Response {
        try await send(method: "POST", path: path, body: body)
    }

    private func send<Body: Encodable, Response: Decodable>(
        method: String,
        path: [String],
        body: Body,
        expectedStatus: Int? = nil
    ) async throws -> Response {
        var request = try request(path: path)
        request.httpMethod = method
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        do {
            request.httpBody = try encoder.encode(body)
        } catch {
            throw PhotoBrainAPIError.invalidRequest
        }
        return try await perform(request, expectedStatus: expectedStatus)
    }

    private func request(path: [String], queryItems: [URLQueryItem] = []) throws -> URLRequest {
        var url = baseURL.appendingPathComponent("api").appendingPathComponent("v1")
        path.forEach { url.appendPathComponent($0) }
        if !queryItems.isEmpty { url.append(queryItems: queryItems) }
        guard let scheme = url.scheme, scheme == "https" || scheme == "http" else {
            throw PhotoBrainAPIError.invalidRequest
        }
        var request = URLRequest(url: url)
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        return request
    }

    /// Decodes a JSON body. `expectedStatus` pins the success status (e.g. `201` for create);
    /// when nil any 2xx is accepted.
    private func perform<Response: Decodable>(
        _ request: URLRequest,
        expectedStatus: Int? = nil
    ) async throws -> Response {
        let data = try await transfer(request, expectedStatus: expectedStatus)
        let endpoint = request.url?.path ?? "unknown"
        let decodeSignpost = SpikeSignposts.beginJSONDecode(
            endpoint: endpoint,
            byteCount: data.count
        )
        do {
            let decoded = try decoder.decode(Response.self, from: data)
            SpikeSignposts.endJSONDecode(decodeSignpost, succeeded: true)
            return decoded
        } catch {
            SpikeSignposts.endJSONDecode(decodeSignpost, succeeded: false)
            throw PhotoBrainAPIError.decoding(String(describing: error))
        }
    }

    /// Sends `request` and returns the body of a successful response. Non-2xx responses map to
    /// `.server`; a 2xx other than `expectedStatus` is an invalid response.
    private func transfer(_ request: URLRequest, expectedStatus: Int?) async throws -> Data {
        let identifier = UUID()
        let endpoint = request.url?.path ?? "unknown"
        let metricsDelegate = APITransferMetricsDelegate(endpoint: endpoint)
        let transferSignpost = SpikeSignposts.beginAPITransfer(endpoint: endpoint)
        let task = Task {
            try await session.data(for: request, delegate: metricsDelegate)
        }
        store(task, id: identifier)

        let transfer: (Data, URLResponse)
        do {
            transfer = try await withTaskCancellationHandler {
                try Task.checkCancellation()
                return try await task.value
            } onCancel: { [weak self] in
                self?.cancelTask(identifier)
            }
            removeTask(identifier)
            SpikeSignposts.endAPITransfer(
                transferSignpost,
                endpoint: endpoint,
                byteCount: transfer.0.count,
                succeeded: true
            )
        } catch is CancellationError {
            removeTask(identifier)
            SpikeSignposts.endAPITransfer(
                transferSignpost,
                endpoint: endpoint,
                byteCount: 0,
                succeeded: false
            )
            throw CancellationError()
        } catch let error as URLError where error.code == .cancelled {
            removeTask(identifier)
            SpikeSignposts.endAPITransfer(
                transferSignpost,
                endpoint: endpoint,
                byteCount: 0,
                succeeded: false
            )
            throw CancellationError()
        } catch let error as PhotoBrainAPIError {
            removeTask(identifier)
            SpikeSignposts.endAPITransfer(
                transferSignpost,
                endpoint: endpoint,
                byteCount: 0,
                succeeded: false
            )
            throw error
        } catch {
            removeTask(identifier)
            SpikeSignposts.endAPITransfer(
                transferSignpost,
                endpoint: endpoint,
                byteCount: 0,
                succeeded: false
            )
            throw PhotoBrainAPIError.transport(error.localizedDescription)
        }

        let (data, response) = transfer
        guard let http = response as? HTTPURLResponse else {
            throw PhotoBrainAPIError.invalidResponse
        }
        guard data.count <= maximumJSONBytes else {
            throw PhotoBrainAPIError.decoding("Response exceeded the 16 MiB contract")
        }
        guard (200..<300).contains(http.statusCode) else {
            if let envelope = try? decoder.decode(APIErrorEnvelope.self, from: data) {
                throw PhotoBrainAPIError.server(
                    status: http.statusCode,
                    code: envelope.error.code,
                    message: envelope.error.message
                )
            }
            throw PhotoBrainAPIError.server(
                status: http.statusCode,
                code: "HTTP_\(http.statusCode)",
                message: HTTPURLResponse.localizedString(forStatusCode: http.statusCode)
            )
        }
        if let expectedStatus, http.statusCode != expectedStatus {
            throw PhotoBrainAPIError.invalidResponse
        }
        return data
    }

    private func store(_ task: Task<(Data, URLResponse), Error>, id: UUID) {
        lock.lock()
        tasks[id] = task
        lock.unlock()
    }

    private func removeTask(_ id: UUID) {
        lock.lock()
        tasks[id] = nil
        lock.unlock()
    }

    private func cancelTask(_ id: UUID) {
        lock.lock()
        let task = tasks.removeValue(forKey: id)
        lock.unlock()
        task?.cancel()
    }
}

private final class APITransferMetricsDelegate: NSObject, URLSessionTaskDelegate, @unchecked Sendable {
    private let endpoint: String

    init(endpoint: String) {
        self.endpoint = endpoint
    }

    func urlSession(
        _ session: URLSession,
        task: URLSessionTask,
        didFinishCollecting metrics: URLSessionTaskMetrics
    ) {
        SpikeSignposts.recordAPITransferMetrics(
            endpoint: endpoint,
            measurement: URLSessionTransferMeasurement(metrics: metrics)
        )
    }
}
