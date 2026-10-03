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
        body: Body
    ) async throws -> Response {
        var request = try request(path: path)
        request.httpMethod = method
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        do {
            request.httpBody = try encoder.encode(body)
        } catch {
            throw PhotoBrainAPIError.invalidRequest
        }
        return try await perform(request)
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

    private func perform<Response: Decodable>(_ request: URLRequest) async throws -> Response {
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
