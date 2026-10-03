import Foundation
import os.signpost

enum SpikeSignposts {
    private static let log = OSLog(subsystem: "com.photobrain.app", category: "NativeFeasibility")

    static func beginAPITransfer(endpoint: String) -> OSSignpostID {
        let id = OSSignpostID(log: log)
        os_signpost(
            .begin,
            log: log,
            name: "APITransfer",
            signpostID: id,
            "endpoint=%{public}@",
            endpoint as NSString
        )
        return id
    }

    static func endAPITransfer(
        _ id: OSSignpostID,
        endpoint: String,
        byteCount: Int,
        succeeded: Bool
    ) {
        os_signpost(
            .end,
            log: log,
            name: "APITransfer",
            signpostID: id,
            "endpoint=%{public}@ decoded_body_bytes=%{public}d succeeded=%{public}d",
            endpoint as NSString,
            byteCount,
            succeeded ? 1 : 0
        )
    }

    static func recordAPITransferMetrics(
        endpoint: String,
        measurement: URLSessionTransferMeasurement
    ) {
        recordTransferMetrics(
            name: "APITransferMetrics",
            endpoint: endpoint,
            imageContext: nil,
            measurement: measurement
        )
    }

    static func beginJSONDecode(endpoint: String, byteCount: Int) -> OSSignpostID {
        let id = OSSignpostID(log: log)
        os_signpost(
            .begin,
            log: log,
            name: "JSONDecode",
            signpostID: id,
            "endpoint=%{public}@ bytes=%{public}d",
            endpoint as NSString,
            byteCount
        )
        return id
    }

    static func endJSONDecode(_ id: OSSignpostID, succeeded: Bool) {
        os_signpost(
            .end,
            log: log,
            name: "JSONDecode",
            signpostID: id,
            "succeeded=%{public}d",
            succeeded ? 1 : 0
        )
    }

    static func beginGroup(recordCount: Int) -> OSSignpostID {
        let id = OSSignpostID(log: log)
        os_signpost(
            .begin,
            log: log,
            name: "ResolverGroup",
            signpostID: id,
            "records=%{public}d",
            recordCount
        )
        return id
    }

    static func endGroup(_ id: OSSignpostID, recordCount: Int) {
        os_signpost(
            .end,
            log: log,
            name: "ResolverGroup",
            signpostID: id,
            "records=%{public}d",
            recordCount
        )
    }

    static func beginCapturedPresentation(
        recordCount: Int,
        grouping: LibraryGrouping,
        sort: LibrarySort
    ) -> OSSignpostID {
        let id = OSSignpostID(log: log)
        os_signpost(
            .begin,
            log: log,
            name: "CapturedPresentation",
            signpostID: id,
            "records=%{public}d grouping=%{public}@ sort=%{public}@",
            recordCount,
            grouping.rawValue as NSString,
            sort.rawValue as NSString
        )
        return id
    }

    static func endCapturedPresentation(
        _ id: OSSignpostID,
        recordCount: Int,
        sectionCount: Int
    ) {
        os_signpost(
            .end,
            log: log,
            name: "CapturedPresentation",
            signpostID: id,
            "records=%{public}d sections=%{public}d",
            recordCount,
            sectionCount
        )
    }

    static func beginSnapshot(itemCount: Int, sectionCount: Int) -> OSSignpostID {
        let id = OSSignpostID(log: log)
        os_signpost(
            .begin,
            log: log,
            name: "SnapshotBuildAndApply",
            signpostID: id,
            "items=%{public}d sections=%{public}d",
            itemCount,
            sectionCount
        )
        return id
    }

    static func endSnapshot(_ id: OSSignpostID) {
        os_signpost(.end, log: log, name: "SnapshotBuildAndApply", signpostID: id)
    }

    static func beginImageTransfer(context: ImageInstrumentationContext) -> OSSignpostID {
        let id = OSSignpostID(log: log)
        os_signpost(
            .begin,
            log: log,
            name: "ImageTransfer",
            signpostID: id,
            "photo_id=%{public}d url=%{public}@",
            context.photoID,
            context.versionedURL as NSString
        )
        return id
    }

    static func endImageTransfer(
        _ id: OSSignpostID,
        context: ImageInstrumentationContext,
        byteCount: Int,
        succeeded: Bool
    ) {
        os_signpost(
            .end,
            log: log,
            name: "ImageTransfer",
            signpostID: id,
            "photo_id=%{public}d url=%{public}@ decoded_body_bytes=%{public}d succeeded=%{public}d",
            context.photoID,
            context.versionedURL as NSString,
            byteCount,
            succeeded ? 1 : 0
        )
    }

    static func recordImageTransferMetrics(
        context: ImageInstrumentationContext,
        measurement: URLSessionTransferMeasurement
    ) {
        recordTransferMetrics(
            name: "ImageTransferMetrics",
            endpoint: nil,
            imageContext: context,
            measurement: measurement
        )
    }

    static func imageCacheEvent(
        context: ImageInstrumentationContext,
        result: ImageCacheResult
    ) {
        os_signpost(
            .event,
            log: log,
            name: "ImageCache",
            "photo_id=%{public}d url=%{public}@ result=%{public}@",
            context.photoID,
            context.versionedURL as NSString,
            result.rawValue as NSString
        )
    }

    static func beginImageDecode(context: ImageInstrumentationContext, byteCount: Int) -> OSSignpostID {
        let id = OSSignpostID(log: log)
        os_signpost(
            .begin,
            log: log,
            name: "ImageDecode",
            signpostID: id,
            "photo_id=%{public}d url=%{public}@ bytes=%{public}d",
            context.photoID,
            context.versionedURL as NSString,
            byteCount
        )
        return id
    }

    static func endImageDecode(
        _ id: OSSignpostID,
        context: ImageInstrumentationContext,
        succeeded: Bool
    ) {
        os_signpost(
            .end,
            log: log,
            name: "ImageDecode",
            signpostID: id,
            "photo_id=%{public}d url=%{public}@ succeeded=%{public}d",
            context.photoID,
            context.versionedURL as NSString,
            succeeded ? 1 : 0
        )
    }

    private static func recordTransferMetrics(
        name: StaticString,
        endpoint: String?,
        imageContext: ImageInstrumentationContext?,
        measurement: URLSessionTransferMeasurement
    ) {
        let ttfb = measurement.timeToFirstByteMilliseconds ?? -1
        let bodyCompletion = measurement.bodyCompletionMilliseconds ?? -1
        if let imageContext {
            os_signpost(
                .event,
                log: log,
                name: name,
                "photo_id=%{public}d url=%{public}@ ttfb_ms=%{public}.3f body_completion_ms=%{public}.3f wire_bytes=%{public}lld header_wire_bytes=%{public}lld body_wire_bytes=%{public}lld decoded_body_bytes=%{public}lld transactions=%{public}d",
                imageContext.photoID,
                imageContext.versionedURL as NSString,
                ttfb,
                bodyCompletion,
                measurement.responseWireBytes,
                measurement.responseHeaderWireBytes,
                measurement.responseBodyWireBytes,
                measurement.responseBodyDecodedBytes,
                measurement.transactionCount
            )
        } else {
            os_signpost(
                .event,
                log: log,
                name: name,
                "endpoint=%{public}@ ttfb_ms=%{public}.3f body_completion_ms=%{public}.3f wire_bytes=%{public}lld header_wire_bytes=%{public}lld body_wire_bytes=%{public}lld decoded_body_bytes=%{public}lld transactions=%{public}d",
                (endpoint ?? "") as NSString,
                ttfb,
                bodyCompletion,
                measurement.responseWireBytes,
                measurement.responseHeaderWireBytes,
                measurement.responseBodyWireBytes,
                measurement.responseBodyDecodedBytes,
                measurement.transactionCount
            )
        }
    }
}

struct ImageInstrumentationContext: Equatable, Sendable {
    let photoID: Int
    let versionedURL: String

    init(photoID: Int, url: URL) {
        self.init(photoID: photoID, versionedURL: url.absoluteString)
    }

    init(photoID: Int, versionedURL: String) {
        self.photoID = photoID
        self.versionedURL = versionedURL
    }
}

enum ImageCacheResult: String, Sendable {
    case memoryHit = "memory_hit"
    case coalesced = "coalesced"
    case diskHit = "disk_hit"
    case diskStale = "disk_stale"
    case miss = "miss"
    case revalidated = "revalidated"
    case networkResponse = "network_response"
    case storedInMemory = "stored_in_memory"
}

struct URLSessionTransferMeasurement: Equatable, Sendable {
    struct TransactionSample: Equatable, Sendable {
        let fetchStart: Date?
        let responseStart: Date?
        let responseEnd: Date?
        let responseHeaderWireBytes: Int64
        let responseBodyWireBytes: Int64
        let responseBodyDecodedBytes: Int64
    }

    private(set) var timeToFirstByteMilliseconds: Double?
    private(set) var bodyCompletionMilliseconds: Double?
    private(set) var responseHeaderWireBytes: Int64 = 0
    private(set) var responseBodyWireBytes: Int64 = 0
    private(set) var responseBodyDecodedBytes: Int64 = 0
    private(set) var transactionCount = 0

    var responseWireBytes: Int64 {
        responseHeaderWireBytes + responseBodyWireBytes
    }

    init(metrics: URLSessionTaskMetrics) {
        self.init(
            taskStart: metrics.taskInterval.start,
            taskEnd: metrics.taskInterval.end
        )
        for transaction in metrics.transactionMetrics {
            ingest(
                TransactionSample(
                    fetchStart: transaction.fetchStartDate,
                    responseStart: transaction.responseStartDate,
                    responseEnd: transaction.responseEndDate,
                    responseHeaderWireBytes: transaction.countOfResponseHeaderBytesReceived,
                    responseBodyWireBytes: transaction.countOfResponseBodyBytesReceived,
                    responseBodyDecodedBytes: transaction.countOfResponseBodyBytesAfterDecoding
                )
            )
        }
        updateDurations()
    }

    init(
        samples: [TransactionSample],
        taskStart: Date? = nil,
        taskEnd: Date? = nil
    ) {
        self.init(taskStart: taskStart, taskEnd: taskEnd)
        for sample in samples {
            ingest(sample)
        }
        updateDurations()
    }

    private init(taskStart: Date?, taskEnd: Date?) {
        transferStart = taskStart
        fallbackTaskEnd = taskEnd
    }

    private mutating func ingest(_ sample: TransactionSample) {
        transactionCount += 1
        responseHeaderWireBytes += sample.responseHeaderWireBytes
        responseBodyWireBytes += sample.responseBodyWireBytes
        responseBodyDecodedBytes += sample.responseBodyDecodedBytes

        if let fetchStart = sample.fetchStart {
            transferStart = min(transferStart ?? fetchStart, fetchStart)
        }
        if let responseStart = sample.responseStart {
            latestResponseStart = max(latestResponseStart ?? responseStart, responseStart)
        }
        if let responseEnd = sample.responseEnd {
            latestResponseEnd = max(latestResponseEnd ?? responseEnd, responseEnd)
        }
    }

    private mutating func updateDurations() {
        if let transferStart, let latestResponseStart {
            timeToFirstByteMilliseconds = max(
                0,
                latestResponseStart.timeIntervalSince(transferStart) * 1_000
            )
        }
        if let transferStart, let completion = latestResponseEnd ?? fallbackTaskEnd {
            bodyCompletionMilliseconds = max(
                0,
                completion.timeIntervalSince(transferStart) * 1_000
            )
        }
    }

    private var transferStart: Date?
    private var fallbackTaskEnd: Date?
    private var latestResponseStart: Date?
    private var latestResponseEnd: Date?
}
