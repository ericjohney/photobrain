import Foundation
import ImageIO
import UIKit

struct PhotoMediaMetadata: Equatable, Sendable {
    let isConvertedRAW: Bool
}

enum RedirectDecision: Equatable {
    case allow
    case cancel
}

enum RedirectDecisionPolicy {
    static func decision(
        from sourceURL: URL,
        to destinationURL: URL,
        metadata: PhotoMediaMetadata?
    ) -> RedirectDecision {
        let sameHTTPSOrigin = sourceURL.scheme == "https" && destinationURL.scheme == "https"
        let sameLoopbackHTTPOrigin = sourceURL.scheme == "http"
            && destinationURL.scheme == "http"
            && isLoopback(sourceURL.host)
        guard sameHTTPSOrigin || sameLoopbackHTTPOrigin,
              sourceURL.host == destinationURL.host,
              sourceURL.port == destinationURL.port,
              isThumbnailEndpoint(sourceURL),
              isOriginalEndpoint(destinationURL),
              metadata?.isConvertedRAW == true else {
            return .cancel
        }
        return .allow
    }

    private static func isThumbnailEndpoint(_ url: URL) -> Bool {
        url.pathComponents.contains("thumbnail")
    }

    private static func isOriginalEndpoint(_ url: URL) -> Bool {
        url.pathComponents.last == "file"
    }

    private static func isLoopback(_ host: String?) -> Bool {
        guard let host = host?.lowercased() else { return false }
        return host == "localhost" || host == "::1" || host.hasPrefix("127.")
    }
}

final class RedirectAwareImageLoader {
    enum LoadError: Error {
        case invalidResponse
        case oversizedBody
        case decodeFailed
    }

    private static let memoryWarningObserver: NSObjectProtocol = NotificationCenter.default.addObserver(
        forName: UIApplication.didReceiveMemoryWarningNotification,
        object: nil,
        queue: .main
    ) { _ in
        Task { await SharedImagePipeline.shared.removeAllMemoryImages() }
    }

    init() {
        _ = Self.memoryWarningObserver
    }

    @MainActor
    func image(
        for photo: PhotoRecord,
        url: URL? = nil,
        targetSize: CGSize = CGSize(width: 320, height: 320)
    ) async throws -> UIImage {
        try await image(
            photoID: photo.id,
            url: url ?? photo.thumbnailURL,
            isConvertedRAW: photo.isConvertedRAW,
            targetSize: targetSize
        )
    }

    /// Loads a thumbnail known only by photo id and URL (e.g. a collection cover).
    @MainActor
    func image(
        photoID: Int,
        url: URL,
        isConvertedRAW: Bool,
        targetSize: CGSize
    ) async throws -> UIImage {
        try await SharedImagePipeline.shared.image(
            photoID: photoID,
            url: url,
            metadata: PhotoMediaMetadata(isConvertedRAW: isConvertedRAW),
            targetSize: targetSize,
            scale: UIScreen.main.scale
        )
    }

    func removeAllCachedImages() {
        Task { await SharedImagePipeline.shared.removeAllMemoryImages() }
    }
}


enum LogicalImageDiskCachePolicy {
    static let storedAtHeader = "X-PhotoBrain-Cached-At"

    static func responseForStorage(
        logicalURL: URL,
        transportResponse: HTTPURLResponse,
        now: Date
    ) -> HTTPURLResponse? {
        guard !cacheControlDirectives(transportResponse).contains("no-store") else {
            return nil
        }
        var headers = transportResponse.allHeaderFields.reduce(into: [String: String]()) { result, entry in
            guard let key = entry.key as? String else { return }
            result[key] = String(describing: entry.value)
        }
        headers[storedAtHeader] = String(now.timeIntervalSince1970)
        return HTTPURLResponse(
            url: logicalURL,
            statusCode: 200,
            httpVersion: "HTTP/1.1",
            headerFields: headers
        )
    }

    static func refreshedResponse(
        logicalURL: URL,
        cachedResponse: HTTPURLResponse,
        validationResponse: HTTPURLResponse,
        now: Date
    ) -> HTTPURLResponse? {
        var headers = cachedResponse.allHeaderFields.reduce(into: [String: String]()) { result, entry in
            guard let key = entry.key as? String else { return }
            result[key] = String(describing: entry.value)
        }
        for entry in validationResponse.allHeaderFields {
            guard let key = entry.key as? String else { continue }
            headers[key] = String(describing: entry.value)
        }
        guard let merged = HTTPURLResponse(
            url: logicalURL,
            statusCode: 200,
            httpVersion: "HTTP/1.1",
            headerFields: headers
        ) else { return nil }
        return responseForStorage(logicalURL: logicalURL, transportResponse: merged, now: now)
    }

    static func isFresh(_ response: HTTPURLResponse, now: Date) -> Bool {
        let directives = cacheControlDirectives(response)
        guard !directives.contains("no-cache"),
              !directives.contains("must-revalidate"),
              let storedAtValue = response.value(forHTTPHeaderField: storedAtHeader),
              let storedAt = TimeInterval(storedAtValue),
              let maximumAge = maximumAge(response),
              maximumAge > 0 else { return false }
        return now.timeIntervalSince1970 < storedAt + maximumAge
    }

    static func revalidationHeaders(_ response: HTTPURLResponse) -> [String: String] {
        var headers: [String: String] = [:]
        if let etag = response.value(forHTTPHeaderField: "ETag") {
            headers["If-None-Match"] = etag
        }
        if let modified = response.value(forHTTPHeaderField: "Last-Modified") {
            headers["If-Modified-Since"] = modified
        }
        return headers
    }

    private static func maximumAge(_ response: HTTPURLResponse) -> TimeInterval? {
        for directive in cacheControlDirectives(response) {
            guard directive.hasPrefix("max-age=") else { continue }
            let rawValue = String(directive.dropFirst("max-age=".count))
                .trimmingCharacters(in: CharacterSet(charactersIn: "\""))
            return TimeInterval(rawValue)
        }
        return nil
    }

    private static func cacheControlDirectives(_ response: HTTPURLResponse) -> [String] {
        response.value(forHTTPHeaderField: "Cache-Control")?
            .split(separator: ",")
            .map { $0.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() }
            ?? []
    }
}
private actor SharedImagePipeline {
    static let shared = SharedImagePipeline()

    private struct RequestKey: Hashable, Sendable {
        let photoID: Int
        let logicalURL: String
        let maximumPixelSize: Int
    }

    private struct InFlight {
        let task: Task<UIImage, Error>
        var waiters: Set<UUID>
    }

    private let memoryCache = NSCache<NSString, UIImage>()
    private let diskCache: URLCache
    private let session: URLSession
    private var inFlight: [RequestKey: InFlight] = [:]
    private let maximumBodyBytes = 32 * 1_024 * 1_024

    init() {
        memoryCache.totalCostLimit = 128 * 1_024 * 1_024
        memoryCache.countLimit = 1_500
        diskCache = URLCache(
            memoryCapacity: 32 * 1_024 * 1_024,
            diskCapacity: 512 * 1_024 * 1_024,
            directory: URL.cachesDirectory.appending(path: "PhotoBrainImages", directoryHint: .isDirectory)
        )
        let configuration = URLSessionConfiguration.default
        configuration.urlCache = nil
        configuration.requestCachePolicy = .reloadIgnoringLocalCacheData
        configuration.timeoutIntervalForRequest = 15
        configuration.timeoutIntervalForResource = 30
        configuration.httpMaximumConnectionsPerHost = 6
        session = URLSession(configuration: configuration)
    }

    func image(
        photoID: Int,
        url: URL,
        metadata: PhotoMediaMetadata,
        targetSize: CGSize,
        scale: CGFloat
    ) async throws -> UIImage {
        try Task.checkCancellation()
        let maximumPixelSize = max(
            1,
            min(4_096, Int(ceil(max(targetSize.width, targetSize.height) * max(1, scale))))
        )
        let logicalURL = url.absoluteString
        let key = RequestKey(
            photoID: photoID,
            logicalURL: logicalURL,
            maximumPixelSize: maximumPixelSize
        )
        let context = ImageInstrumentationContext(photoID: photoID, versionedURL: logicalURL)
        let cacheKey = "\(key.photoID)|\(key.logicalURL)|\(key.maximumPixelSize)" as NSString
        if let image = memoryCache.object(forKey: cacheKey) {
            SpikeSignposts.imageCacheEvent(context: context, result: .memoryHit)
            return image
        }

        let waiterID = UUID()
        let task: Task<UIImage, Error>
        if var existing = inFlight[key] {
            SpikeSignposts.imageCacheEvent(context: context, result: .coalesced)
            existing.waiters.insert(waiterID)
            inFlight[key] = existing
            task = existing.task
        } else {
            let request = URLRequest(
                url: url,
                cachePolicy: .reloadIgnoringLocalCacheData,
                timeoutInterval: 15
            )
            let diskCache = diskCache
            let session = session
            let maximumBodyBytes = maximumBodyBytes
            task = Task.detached(priority: .userInitiated) {
                let data: Data
                var cached = diskCache.cachedResponse(for: request)
                if let candidate = cached, candidate.data.count > maximumBodyBytes {
                    diskCache.removeCachedResponse(for: request)
                    cached = nil
                }
                if let cached,
                   let cachedHTTP = cached.response as? HTTPURLResponse,
                   LogicalImageDiskCachePolicy.isFresh(cachedHTTP, now: Date()) {
                    SpikeSignposts.imageCacheEvent(context: context, result: .diskHit)
                    data = cached.data
                } else {
                    SpikeSignposts.imageCacheEvent(
                        context: context,
                        result: cached == nil ? .miss : .diskStale
                    )
                    var validationRequest = request
                    if let cachedHTTP = cached?.response as? HTTPURLResponse {
                        for (field, value) in LogicalImageDiskCachePolicy.revalidationHeaders(cachedHTTP) {
                            validationRequest.setValue(value, forHTTPHeaderField: field)
                        }
                    }
                    let delegate = RedirectDelegate(metadata: metadata, context: context)
                    let transfer = SpikeSignposts.beginImageTransfer(context: context)
                    let received: (Data, URLResponse)
                    do {
                        received = try await session.data(for: validationRequest, delegate: delegate)
                        SpikeSignposts.endImageTransfer(
                            transfer,
                            context: context,
                            byteCount: received.0.count,
                            succeeded: true
                        )
                    } catch {
                        SpikeSignposts.endImageTransfer(
                            transfer,
                            context: context,
                            byteCount: 0,
                            succeeded: false
                        )
                        throw error
                    }
                    guard let http = received.1 as? HTTPURLResponse else {
                        throw RedirectAwareImageLoader.LoadError.invalidResponse
                    }
                    if http.statusCode == 304,
                       let cached,
                       let cachedHTTP = cached.response as? HTTPURLResponse {
                        SpikeSignposts.imageCacheEvent(context: context, result: .revalidated)
                        data = cached.data
                        if let refreshed = LogicalImageDiskCachePolicy.refreshedResponse(
                            logicalURL: url,
                            cachedResponse: cachedHTTP,
                            validationResponse: http,
                            now: Date()
                        ) {
                            diskCache.storeCachedResponse(
                                CachedURLResponse(response: refreshed, data: data, storagePolicy: .allowed),
                                for: request
                            )
                        }
                    } else {
                        guard (200..<300).contains(http.statusCode) else {
                            throw RedirectAwareImageLoader.LoadError.invalidResponse
                        }
                        guard received.0.count <= maximumBodyBytes else {
                            throw RedirectAwareImageLoader.LoadError.oversizedBody
                        }
                        SpikeSignposts.imageCacheEvent(context: context, result: .networkResponse)
                        data = received.0
                        if let logicalResponse = LogicalImageDiskCachePolicy.responseForStorage(
                            logicalURL: url,
                            transportResponse: http,
                            now: Date()
                        ) {
                            diskCache.storeCachedResponse(
                                CachedURLResponse(
                                    response: logicalResponse,
                                    data: data,
                                    storagePolicy: .allowed
                                ),
                                for: request
                            )
                        } else {
                            diskCache.removeCachedResponse(for: request)
                        }
                    }
                }

                try Task.checkCancellation()
                let decode = SpikeSignposts.beginImageDecode(
                    context: context,
                    byteCount: data.count
                )
                var decoded = false
                defer {
                    SpikeSignposts.endImageDecode(
                        decode,
                        context: context,
                        succeeded: decoded
                    )
                }
                guard let source = CGImageSourceCreateWithData(data as CFData, nil),
                      let cgImage = CGImageSourceCreateThumbnailAtIndex(
                          source,
                          0,
                          [
                              kCGImageSourceCreateThumbnailFromImageAlways: true,
                              kCGImageSourceCreateThumbnailWithTransform: true,
                              kCGImageSourceShouldCacheImmediately: true,
                              kCGImageSourceThumbnailMaxPixelSize: maximumPixelSize,
                          ] as CFDictionary
                      ) else {
                    throw RedirectAwareImageLoader.LoadError.decodeFailed
                }
                decoded = true
                return UIImage(cgImage: cgImage, scale: scale, orientation: .up)
            }
            inFlight[key] = InFlight(task: task, waiters: [waiterID])
        }

        return try await withTaskCancellationHandler {
            do {
                let image = try await task.value
                try Task.checkCancellation()
                finish(waiterID: waiterID, key: key)
                let cost = image.cgImage.map { $0.bytesPerRow * $0.height } ?? 0
                memoryCache.setObject(image, forKey: cacheKey, cost: cost)
                SpikeSignposts.imageCacheEvent(context: context, result: .storedInMemory)
                return image
            } catch {
                finish(waiterID: waiterID, key: key)
                throw error
            }
        } onCancel: {
            Task { await self.cancel(waiterID: waiterID, key: key) }
        }
    }

    func removeAllMemoryImages() {
        memoryCache.removeAllObjects()
    }

    private func finish(waiterID: UUID, key: RequestKey) {
        guard var request = inFlight[key] else { return }
        request.waiters.remove(waiterID)
        if request.waiters.isEmpty {
            inFlight[key] = nil
        } else {
            inFlight[key] = request
        }
    }

    private func cancel(waiterID: UUID, key: RequestKey) {
        guard var request = inFlight[key] else { return }
        request.waiters.remove(waiterID)
        if request.waiters.isEmpty {
            request.task.cancel()
            inFlight[key] = nil
        } else {
            inFlight[key] = request
        }
    }
}

private final class RedirectDelegate: NSObject, URLSessionTaskDelegate, @unchecked Sendable {
    let metadata: PhotoMediaMetadata
    private let context: ImageInstrumentationContext

    init(metadata: PhotoMediaMetadata, context: ImageInstrumentationContext) {
        self.metadata = metadata
        self.context = context
    }

    func urlSession(
        _ session: URLSession,
        task: URLSessionTask,
        willPerformHTTPRedirection response: HTTPURLResponse,
        newRequest request: URLRequest,
        completionHandler: @escaping (URLRequest?) -> Void
    ) {
        guard let sourceURL = response.url, let destinationURL = request.url else {
            completionHandler(nil)
            return
        }
        let decision = RedirectDecisionPolicy.decision(
            from: sourceURL,
            to: destinationURL,
            metadata: metadata
        )
        completionHandler(decision == .allow ? request : nil)
    }

    func urlSession(
        _ session: URLSession,
        task: URLSessionTask,
        didFinishCollecting metrics: URLSessionTaskMetrics
    ) {
        SpikeSignposts.recordImageTransferMetrics(
            context: context,
            measurement: URLSessionTransferMeasurement(metrics: metrics)
        )
    }
}
