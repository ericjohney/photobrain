import Foundation
import UniformTypeIdentifiers

/// `size` query value of the binary export routes.
enum ExportSize: String, CaseIterable, Sendable {
    /// Source bytes unchanged (RAW stays RAW, HEIC stays HEIC).
    case original
    /// Metadata-free JPEG, long edge at most 2,048 px.
    case jpeg2048 = "2048"
    /// Metadata-free JPEG, long edge at most 1,024 px.
    case jpeg1024 = "1024"
}

/// What one export downloads: a single photo or a manual collection as a ZIP.
enum ExportTarget: Hashable, Sendable {
    case photo(id: Int, size: ExportSize)
    case collection(id: Int, size: ExportSize)

    var id: Int {
        switch self {
        case let .photo(id, _), let .collection(id, _): id
        }
    }

    /// `GET /api/photos/{id}/export?size=` or `GET /api/collections/{id}/export?size=`. These are
    /// binary routes outside `/api/v1`; `size` is always sent explicitly because the two routes
    /// default differently.
    func url(baseURL: URL) -> URL {
        let (resource, size): (String, ExportSize) = switch self {
        case let .photo(_, size): ("photos", size)
        case let .collection(_, size): ("collections", size)
        }
        var url = baseURL
            .appendingPathComponent("api")
            .appendingPathComponent(resource)
            .appendingPathComponent(String(id))
            .appendingPathComponent("export")
        url.append(queryItems: [URLQueryItem(name: "size", value: size.rawValue)])
        return url
    }

    /// Name used when the response has no usable `Content-Disposition` filename. Mirrors the
    /// server's naming (`{stem}_{size}.jpg`, `{name}.zip`) with the id standing in for the name.
    func fallbackFilename(mimeType: String?) -> String {
        switch self {
        case let .photo(id, .original):
            let fileExtension = mimeType.flatMap { UTType(mimeType: $0)?.preferredFilenameExtension }
            return fileExtension.map { "photo-\(id).\($0)" } ?? "photo-\(id)"
        case let .photo(id, size):
            return "photo-\(id)_\(size.rawValue).jpg"
        case let .collection(id, _):
            return "collection-\(id).zip"
        }
    }
}

struct ExportProgress: Equatable, Sendable {
    var received: Int64
    /// `nil` when the server sends no `Content-Length` (collection ZIPs).
    var expected: Int64?

    var fraction: Double? {
        guard let expected, expected > 0 else { return nil }
        return min(1, Double(received) / Double(expected))
    }
}

/// A downloaded export: the only file in its own temporary directory.
struct ExportFile: Hashable, Identifiable, Sendable {
    let url: URL

    var id: URL { url }
    var directory: URL { url.deletingLastPathComponent() }

    /// Deletes the export's directory, and with it the file. Safe to call more than once.
    func remove() {
        try? FileManager.default.removeItem(at: directory)
    }
}

/// RFC 6266 `Content-Disposition` filename extraction.
enum ContentDisposition {
    /// The RFC 5987 `filename*` value when it decodes, else the plain `filename` value, else
    /// `nil`. The result is not filesystem-safe; pass it through `ExportFilename.sanitized`.
    static func filename(from header: String?) -> String? {
        guard let header else { return nil }
        var plain: String?
        var extended: String?
        for parameter in parameters(header) {
            guard let equals = parameter.firstIndex(of: "=") else { continue }
            let name = parameter[..<equals].trimmingCharacters(in: .whitespaces).lowercased()
            let value = unquoted(parameter[parameter.index(after: equals)...].trimmingCharacters(in: .whitespaces))
            switch name {
            case "filename*" where extended == nil: extended = decodeExtended(value)
            case "filename" where plain == nil: plain = value.isEmpty ? nil : value
            default: continue
            }
        }
        return extended ?? plain
    }

    /// Splits on `;` outside quoted strings.
    private static func parameters(_ header: String) -> [String] {
        var parts: [String] = []
        var current = ""
        var inQuotes = false
        var escaped = false
        for character in header {
            if escaped {
                escaped = false
            } else if inQuotes, character == "\\" {
                escaped = true
            } else if character == "\"" {
                inQuotes.toggle()
            } else if character == ";", !inQuotes {
                parts.append(current)
                current = ""
                continue
            }
            current.append(character)
        }
        parts.append(current)
        return parts
    }

    /// Removes surrounding quotes and backslash escapes from a quoted-string; tokens pass through.
    private static func unquoted(_ value: String) -> String {
        guard value.first == "\"" else { return value }
        var result = ""
        var escaped = false
        for character in value.dropFirst() {
            if escaped {
                result.append(character)
                escaped = false
            } else if character == "\\" {
                escaped = true
            } else if character == "\"" {
                break
            } else {
                result.append(character)
            }
        }
        return result
    }

    /// `charset'language'percent-encoded`; UTF-8 and ISO-8859-1 per RFC 5987.
    private static func decodeExtended(_ value: String) -> String? {
        let parts = value.split(separator: "'", maxSplits: 2, omittingEmptySubsequences: false)
        guard parts.count == 3 else { return nil }
        let encoding: String.Encoding
        switch parts[0].lowercased() {
        case "utf-8": encoding = .utf8
        case "iso-8859-1": encoding = .isoLatin1
        default: return nil
        }
        guard let bytes = percentDecoded(parts[2]),
              let decoded = String(data: bytes, encoding: encoding),
              !decoded.isEmpty else { return nil }
        return decoded
    }

    private static func percentDecoded(_ text: Substring) -> Data? {
        var bytes = Data()
        var iterator = text.utf8.makeIterator()
        while let byte = iterator.next() {
            guard byte == UInt8(ascii: "%") else {
                bytes.append(byte)
                continue
            }
            guard let high = iterator.next().flatMap(hexValue),
                  let low = iterator.next().flatMap(hexValue) else { return nil }
            bytes.append(high << 4 | low)
        }
        return bytes
    }

    private static func hexValue(_ byte: UInt8) -> UInt8? {
        switch byte {
        case UInt8(ascii: "0")...UInt8(ascii: "9"): byte - UInt8(ascii: "0")
        case UInt8(ascii: "a")...UInt8(ascii: "f"): byte - UInt8(ascii: "a") + 10
        case UInt8(ascii: "A")...UInt8(ascii: "F"): byte - UInt8(ascii: "A") + 10
        default: nil
        }
    }
}

/// RFC 9110 `Retry-After`: delta-seconds or an IMF-fixdate.
enum RetryAfter {
    /// Whole seconds to wait, rounded up and at least 0; `nil` when absent or unparseable.
    static func seconds(from header: String?, now: Date = Date()) -> Int? {
        guard let value = header?.trimmingCharacters(in: .whitespaces), !value.isEmpty else { return nil }
        if value.allSatisfy(\.isASCII), value.allSatisfy(\.isNumber) {
            return Int(value) ?? Int.max
        }
        guard let date = httpDate.date(from: value) else { return nil }
        return max(0, Int(date.timeIntervalSince(now).rounded(.up)))
    }

    private static let httpDate: DateFormatter = {
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.timeZone = TimeZone(identifier: "GMT")
        formatter.dateFormat = "EEE, dd MMM yyyy HH:mm:ss 'GMT'"
        return formatter
    }()
}

/// Makes a server-provided filename safe to create inside an export directory.
enum ExportFilename {
    /// APFS name limit in UTF-8 bytes.
    static let maximumBytes = 255

    /// Keeps only the last `/`- or `\`-separated component, replaces control characters, bidi
    /// overrides, and `:` with `_`, and strips leading dots (no `..` or hidden files). Over-long
    /// names are truncated with their extension kept. `nil` when nothing usable remains.
    static func sanitized(_ raw: String) -> String? {
        let component = raw.split(whereSeparator: { $0 == "/" || $0 == "\\" }).last.map(String.init) ?? ""
        var scalars = String.UnicodeScalarView()
        for scalar in component.unicodeScalars {
            scalars.append(isUnsafe(scalar) ? "_" : scalar)
        }
        let trimmed = String(scalars).trimmingCharacters(in: .whitespaces)
        let name = String(trimmed.drop { $0 == "." || $0.isWhitespace })
        guard !name.isEmpty else { return nil }
        return truncated(name)
    }

    private static func isUnsafe(_ scalar: Unicode.Scalar) -> Bool {
        scalar == ":"
            || scalar.properties.generalCategory == .control
            || (0x202A...0x202E).contains(scalar.value)
            || (0x2066...0x2069).contains(scalar.value)
    }

    private static func truncated(_ name: String) -> String {
        guard name.utf8.count > maximumBytes else { return name }
        let fileExtension = (name as NSString).pathExtension
        let suffix = fileExtension.isEmpty || fileExtension.utf8.count > 16 ? "" : "." + fileExtension
        var stem = suffix.isEmpty ? name : String(name.dropLast(suffix.count))
        while stem.utf8.count + suffix.utf8.count > maximumBytes {
            stem.removeLast()
        }
        return stem + suffix
    }
}

/// Shared between a running download, its cancellation handler, and its progress observation.
final class ExportDownloadControl: @unchecked Sendable {
    /// Smallest byte delta between progress reports; at most ~100 reports when the size is known.
    private static let minimumStride: Int64 = 256 * 1_024

    private let lock = NSLock()
    private let onProgress: @Sendable (ExportProgress) -> Void
    private var task: URLSessionDownloadTask?
    private var observation: NSKeyValueObservation?
    private var cancelled = false
    private var finished = false
    private var lastReported: Int64 = -1

    init(onProgress: @escaping @Sendable (ExportProgress) -> Void) {
        self.onProgress = onProgress
    }

    var isCancelled: Bool {
        lock.lock()
        defer { lock.unlock() }
        return cancelled
    }

    /// Observes and resumes `task`; a cancellation that arrived first cancels it immediately,
    /// which still delivers its completion handler.
    func start(_ task: URLSessionDownloadTask) {
        let observation = task.observe(\.countOfBytesReceived, options: [.new]) { [weak self] task, _ in
            self?.report(received: task.countOfBytesReceived, expected: task.countOfBytesExpectedToReceive)
        }
        lock.lock()
        self.task = task
        self.observation = observation
        let cancelled = cancelled
        lock.unlock()
        task.resume()
        if cancelled { task.cancel() }
    }

    func cancel() {
        lock.lock()
        cancelled = true
        let task = task
        lock.unlock()
        task?.cancel()
    }

    /// Stops progress reporting and releases the task. `final` is reported last when given.
    func finish(final: ExportProgress?) {
        lock.lock()
        finished = true
        let observation = observation
        self.observation = nil
        task = nil
        lock.unlock()
        observation?.invalidate()
        if let final { onProgress(final) }
    }

    private func report(received: Int64, expected: Int64) {
        let expected = expected > 0 ? expected : nil
        let stride = max(Self.minimumStride, (expected ?? 0) / 100)
        lock.lock()
        guard !finished, lastReported < 0 || received - lastReported >= stride else {
            lock.unlock()
            return
        }
        lastReported = received
        lock.unlock()
        onProgress(ExportProgress(received: received, expected: expected))
    }
}
