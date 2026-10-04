import Foundation

/// The upload routes the backup uses besides the binary `POST /uploads`.
protocol BackupServerAPI: Sendable {
    /// `GET /uploads/config`; readable even while uploads are disabled.
    func uploadConfig() async throws -> UploadConfigDTO
    /// `POST /uploads/known` for 1-1000 asset ids.
    func knownUploads(deviceId: String, assetIds: [String]) async throws -> KnownUploadsResponseDTO
}

/// Formats `capturedAt`: ISO-8601 with the offset of `timeZone` (the device's zone when the
/// backup runs), e.g. `2026-10-03T14:05:09+02:00`, or `Z` for UTC.
struct BackupCapturedAtFormatter {
    private let formatter: ISO8601DateFormatter

    init(timeZone: TimeZone) {
        formatter = ISO8601DateFormatter()
        formatter.timeZone = timeZone
        formatter.formatOptions = [.withInternetDateTime]
    }

    func string(from date: Date) -> String {
        formatter.string(from: date)
    }
}

enum UploadRequestBuilder {
    /// RFC 3986 unreserved characters; everything else, `+` included, is percent-encoded so the
    /// server never reads `+` as a space.
    private static let unreserved = CharacterSet(
        charactersIn: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~"
    )

    /// `POST /api/v1/uploads` with `deviceId`, `deviceName`, `filename`, `assetId`, `resource`,
    /// and `capturedAt` when the asset has a creation date.
    static func url(
        baseURL: URL,
        deviceId: String,
        deviceName: String,
        item: BackupItem,
        capturedAt: BackupCapturedAtFormatter
    ) -> URL? {
        var pairs: [(String, String)] = [
            ("deviceId", deviceId),
            ("deviceName", deviceName),
            ("filename", item.filename),
            ("assetId", item.assetId),
            ("resource", item.resource.rawValue),
        ]
        if let date = item.capturedAt {
            pairs.append(("capturedAt", capturedAt.string(from: date)))
        }
        let query = pairs.compactMap { name, value -> String? in
            guard let encoded = value.addingPercentEncoding(withAllowedCharacters: unreserved) else { return nil }
            return "\(name)=\(encoded)"
        }
        guard query.count == pairs.count else { return nil }
        let endpoint = baseURL
            .appendingPathComponent("api")
            .appendingPathComponent("v1")
            .appendingPathComponent("uploads")
        guard var components = URLComponents(url: endpoint, resolvingAgainstBaseURL: false),
              components.scheme == "https" || components.scheme == "http" else { return nil }
        components.percentEncodedQuery = query.joined(separator: "&")
        return components.url
    }

    /// The upload request for a background `uploadTask(with:fromFile:)`, which sets
    /// `Content-Length` from the file.
    static func request(url: URL, allowsCellularAccess: Bool) -> URLRequest {
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("application/octet-stream", forHTTPHeaderField: "Content-Type")
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        request.allowsCellularAccess = allowsCellularAccess
        return request
    }
}

/// What a finished upload means for its item.
enum UploadOutcome: Equatable, Sendable {
    /// Stored (`201 created`) or already on the server (`200 duplicate`).
    case done(path: String, duplicate: Bool)
    /// Rejected permanently; never retried automatically.
    case skipped(reason: String)
    /// `503 UPLOADS_DISABLED`: stop the queue; the item stays pending.
    case disabled
    /// Cancelled locally (backup turned off); the item stays pending without backoff.
    case cancelled
    /// Storage full, server error, or network failure: retry later with backoff.
    case retry(message: String)
}

enum UploadResponseClassifier {
    static func classify(status: Int?, body: Data, error: Error?) -> UploadOutcome {
        if let error {
            if (error as? URLError)?.code == .cancelled { return .cancelled }
            return .retry(message: error.localizedDescription)
        }
        guard let status else { return .retry(message: "The server returned an invalid response.") }
        let decoder = APIModelCoding.decoder()
        if status == 200 || status == 201 {
            guard let result = try? decoder.decode(UploadResultDTO.self, from: body),
                  (status == 201) == (result.status == .created) else {
                return .retry(message: "The server returned an invalid response.")
            }
            return .done(path: result.path, duplicate: result.status == .duplicate)
        }
        let envelope = try? decoder.decode(APIErrorEnvelope.self, from: body)
        let code = envelope?.error.code
        let message = envelope?.error.message ?? HTTPURLResponse.localizedString(forStatusCode: status)
        switch (status, code) {
        case (413, _):
            return .skipped(reason: "Larger than the server's upload limit")
        case (415, _):
            return .skipped(reason: "File type not supported by the server")
        case (400, "INVALID_REQUEST"):
            return .skipped(reason: "Rejected by the server: \(message)")
        case (503, "UPLOADS_DISABLED"):
            return .disabled
        case (507, _):
            return .retry(message: "The server is out of storage space.")
        default:
            return .retry(message: "Upload failed (\(status)): \(message)")
        }
    }
}

/// Applies a finished upload task to the ledger: ends the transfer, deletes its temporary file,
/// and records the outcome. Runs on the background session's delegate queue, so completions
/// delivered after a relaunch are persisted before any UI exists.
struct BackupCompletionProcessor: Sendable {
    struct Result: Equatable, Sendable {
        let transfer: BackupLedger.Transfer
        let outcome: UploadOutcome
    }

    let ledger: BackupLedger
    let temporaryDirectory: URL
    var now: @Sendable () -> Date = { Date() }

    /// Nil when the task is not a recorded transfer (already ended, or from an earlier install).
    func complete(tempName: String, status: Int?, body: Data, error: Error?) -> Result? {
        guard let transfer = ledger.endTransfer(tempName) else { return nil }
        try? FileManager.default.removeItem(at: temporaryDirectory.appendingPathComponent(transfer.tempName))
        let outcome = UploadResponseClassifier.classify(status: status, body: body, error: error)
        switch outcome {
        case let .done(path, _):
            ledger.record(transfer.key, BackupLedger.Record(status: .uploaded, detail: path))
        case let .skipped(reason):
            ledger.record(transfer.key, BackupLedger.Record(status: .skipped, detail: reason))
        case let .retry(message):
            ledger.recordRetry(transfer.key, message: message, now: now())
        case .disabled, .cancelled:
            break
        }
        return Result(transfer: transfer, outcome: outcome)
    }
}

/// Creates file uploads; the background `URLSession` in the app, a fake in tests. Tasks are
/// identified by their `taskDescription`, the transfer's temporary file name, because task
/// identifiers are not stable across relaunches.
protocol UploadTransport: AnyObject, Sendable {
    /// Starts uploading `file` with `request`, tagged with `description`.
    func startUpload(_ request: URLRequest, fromFile file: URL, description: String)
    /// Descriptions of tasks the session still owns (running or suspended).
    func activeTaskDescriptions() async -> Set<String>
    func cancelAll()
}

/// Receives the background session's events on its serial delegate queue.
protocol UploadSessionEvents: AnyObject, Sendable {
    func uploadDidComplete(description: String, status: Int?, body: Data, error: Error?)
    func uploadDidProgress(description: String, sent: Int64, expected: Int64)
}

/// The backup's background `URLSession`. Recreated with the same identifier at every launch so
/// the system reconnects uploads that finished while the app was suspended or terminated.
final class BackgroundUploadSession: NSObject, UploadTransport, URLSessionDataDelegate, @unchecked Sendable {
    let identifier: String

    private let events: UploadSessionEvents
    private let lock = NSLock()
    private var bodies: [Int: Data] = [:]
    private var finishEventsHandlers: [() -> Void] = []
    /// The session delivered every queued event before the app delegate handed over the
    /// system's completion handler (the session is created at launch, so the two race).
    private var finishedWithoutHandler = false
    private let maximumBodyBytes = 64 * 1_024
    private var session: URLSession!

    /// `events` must be ready before the session exists: relaunch completions can arrive as
    /// soon as it is created.
    init(identifier: String, events: UploadSessionEvents) {
        self.identifier = identifier
        self.events = events
        super.init()
        let configuration = URLSessionConfiguration.background(withIdentifier: identifier)
        configuration.sessionSendsLaunchEvents = true
        configuration.isDiscretionary = false
        // Cellular use is decided per request from the backup setting.
        configuration.allowsCellularAccess = true
        configuration.timeoutIntervalForResource = 7 * 24 * 60 * 60
        let queue = OperationQueue()
        queue.maxConcurrentOperationCount = 1
        queue.name = "PhotoBrain backup uploads"
        session = URLSession(configuration: configuration, delegate: self, delegateQueue: queue)
    }

    /// Stores the system's completion handler from `handleEventsForBackgroundURLSession`; it is
    /// called once every queued event has been delivered (and therefore persisted).
    func addBackgroundEventsCompletionHandler(_ handler: @escaping () -> Void) {
        let finished = lock.withLock {
            if finishedWithoutHandler {
                finishedWithoutHandler = false
                return true
            }
            finishEventsHandlers.append(handler)
            return false
        }
        if finished { DispatchQueue.main.async { handler() } }
    }

    func startUpload(_ request: URLRequest, fromFile file: URL, description: String) {
        let task = session.uploadTask(with: request, fromFile: file)
        task.taskDescription = description
        task.resume()
    }

    func activeTaskDescriptions() async -> Set<String> {
        await withCheckedContinuation { continuation in
            session.getAllTasks { tasks in
                continuation.resume(returning: Set(tasks.compactMap(\.taskDescription)))
            }
        }
    }

    func cancelAll() {
        session.getAllTasks { tasks in tasks.forEach { $0.cancel() } }
    }

    func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive data: Data) {
        lock.withLock {
            var body = bodies[dataTask.taskIdentifier] ?? Data()
            if body.count + data.count <= maximumBodyBytes { body.append(data) }
            bodies[dataTask.taskIdentifier] = body
        }
    }

    func urlSession(
        _ session: URLSession,
        task: URLSessionTask,
        didSendBodyData bytesSent: Int64,
        totalBytesSent: Int64,
        totalBytesExpectedToSend: Int64
    ) {
        guard let description = task.taskDescription else { return }
        events.uploadDidProgress(description: description, sent: totalBytesSent, expected: totalBytesExpectedToSend)
    }

    func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
        let body = lock.withLock { bodies.removeValue(forKey: task.taskIdentifier) } ?? Data()
        guard let description = task.taskDescription else { return }
        let status = (task.response as? HTTPURLResponse)?.statusCode
        events.uploadDidComplete(description: description, status: status, body: body, error: error)
    }

    func urlSessionDidFinishEvents(forBackgroundURLSession session: URLSession) {
        let handlers = lock.withLock {
            defer { finishEventsHandlers = [] }
            finishedWithoutHandler = finishEventsHandlers.isEmpty
            return finishEventsHandlers
        }
        DispatchQueue.main.async { handlers.forEach { $0() } }
    }
}
