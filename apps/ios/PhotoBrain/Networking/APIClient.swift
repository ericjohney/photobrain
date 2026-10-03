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
}

protocol PhotoBrainAPI: Sendable {
    var baseURL: URL { get }
    func folders() async throws -> FoldersResponseDTO
    func filterOptions(folder: String?) async throws -> FilterOptionsDTO
    func photos(query: PhotoQuery) async throws -> PhotosResponseDTO
    func photo(id: Int) async throws -> PhotoDTO
    func search(query: String, limit: Int, filters: PhotoQuery) async throws -> SearchResponseDTO
    func similarPhotos(id: Int, limit: Int) async throws -> SimilarPhotosResponseDTO
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
        var items = [URLQueryItem(name: "filterRaw", value: query.filterRaw.rawValue)]
        if let folder = query.folder { items.append(URLQueryItem(name: "folder", value: folder)) }
        if let camera = query.camera { items.append(URLQueryItem(name: "camera", value: camera)) }
        if let lens = query.lens { items.append(URLQueryItem(name: "lens", value: lens)) }
        if let iso = query.iso { items.append(URLQueryItem(name: "iso", value: String(iso))) }
        if let month = query.dateMonth { items.append(URLQueryItem(name: "dateMonth", value: month)) }
        if let minRating = query.minRating {
            items.append(URLQueryItem(name: "minRating", value: String(minRating)))
        }
        if let flag = query.flag { items.append(URLQueryItem(name: "flag", value: flag.rawValue)) }
        if let collectionId = query.collectionId {
            items.append(URLQueryItem(name: "collectionId", value: String(collectionId)))
        }
        return try await get(path: ["photos"], queryItems: items)
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

    func similarPhotos(id: Int, limit: Int = 30) async throws -> SimilarPhotosResponseDTO {
        guard id > 0, (1...100).contains(limit) else { throw PhotoBrainAPIError.invalidRequest }
        return try await get(
            path: ["photos", String(id), "similar"],
            queryItems: [URLQueryItem(name: "limit", value: String(limit))]
        )
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
