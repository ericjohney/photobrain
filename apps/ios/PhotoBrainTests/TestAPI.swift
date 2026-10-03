import Foundation
@testable import PhotoBrain

actor TestAPI: PhotoBrainAPI {
    nonisolated let baseURL = URL(string: "https://photos.example.invalid")!
    var photosResponse = PhotosResponseDTO(photos: [], total: 0, rawCount: 0)
    var filterResponse = FilterOptionsDTO(cameras: [], lenses: [], isos: [], dates: [])
    var activeResponse = ActiveScansResponseDTO(jobs: [])
    var scans: [String: ScanDTO] = [:]
    var shouldFailPhotos = false
    var searchDelays: [String: Duration] = [:]
    var searchResponses: [String: SearchResponseDTO] = [:]
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


    func setPhotos(_ response: PhotosResponseDTO, failing: Bool = false) {
        photosResponse = response
        shouldFailPhotos = failing
    }

    func setPhotoFailure(_ failing: Bool) {
        shouldFailPhotos = failing
    }

    func setSearch(query: String, delay: Duration, response: SearchResponseDTO) {
        searchDelays[query] = delay
        searchResponses[query] = response
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


    func folders() async throws -> FoldersResponseDTO {
        FoldersResponseDTO(folders: [], totalPhotos: photosResponse.total)
    }

    func filterOptions(folder: String?) async throws -> FilterOptionsDTO {
        filterResponse
    }

    func photos(query: PhotoQuery) async throws -> PhotosResponseDTO {
        if shouldFailPhotos { throw URLError(.notConnectedToInternet) }
        return photosResponse
    }

    func photo(id: Int) async throws -> PhotoDTO {
        guard let photo = photosResponse.photos.first(where: { $0.id == id }) else {
            throw PhotoBrainAPIError.server(status: 404, code: "PHOTO_NOT_FOUND", message: "Photo not found")
        }
        return photo
    }

    func search(query: String, limit: Int) async throws -> SearchResponseDTO {
        if let delay = searchDelays[query] { try await Task.sleep(for: delay) }
        return searchResponses[query] ?? SearchResponseDTO(photos: [], total: 0, query: query)
    }

    func similarPhotos(id: Int, limit: Int) async throws -> SimilarPhotosResponseDTO {
        similarRequests.append((id, limit))
        if let delay = similarDelays[id], delay > .zero { try await Task.sleep(for: delay) }
        guard let result = similarResponses[id] else {
            throw PhotoBrainAPIError.server(status: 404, code: "PHOTO_NOT_FOUND", message: "Photo not found")
        }
        return try result.get()
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
    static func photo(id: Int, taken: String? = "2024-01-01T12:00:00Z") -> PhotoDTO {
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
            )
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
