import Combine
import Foundation
import UIKit

/// A single ephemeral render for the open loupe. Never enters the thumbnail caches.
@MainActor
final class RawDevelopmentStore: ObservableObject {
    typealias Load = @Sendable (URL) async throws -> Data
    @Published private(set) var photoID: Int?
    @Published private(set) var image: UIImage?
    @Published private(set) var isLoading = false
    @Published private(set) var errorMessage: String?
    private let baseURL: URL
    private let load: Load
    private var task: Task<Void, Never>?
    private var generation = UUID()

    init(baseURL: URL, load: Load? = nil) {
        self.baseURL = baseURL
        self.load = load ?? { url in
            let configuration = URLSessionConfiguration.ephemeral
            configuration.urlCache = nil
            configuration.timeoutIntervalForRequest = 130
            configuration.timeoutIntervalForResource = 150
            let session = URLSession(configuration: configuration)
            defer { session.invalidateAndCancel() }
            var request = URLRequest(url: url, cachePolicy: .reloadIgnoringLocalAndRemoteCacheData)
            request.setValue("image/jpeg", forHTTPHeaderField: "Accept")
            let (data, response) = try await session.data(for: request)
            guard let http = response as? HTTPURLResponse else { throw URLError(.badServerResponse) }
            guard http.statusCode == 200 else {
                struct Failure: Decodable { let error: String }
                let message = (try? JSONDecoder().decode(Failure.self, from: data).error)
                    ?? "Couldn’t develop RAW (HTTP \(http.statusCode))."
                throw NSError(domain: "RawDevelopment", code: http.statusCode,
                              userInfo: [NSLocalizedDescriptionKey: message])
            }
            return data
        }
    }

    static func supports(_ photo: PhotoRecord) -> Bool {
        !photo.isVideo && (photo.isRaw || photo.pairedPhotoId != nil)
    }

    func toggle(_ photo: PhotoRecord) {
        guard Self.supports(photo) else { return }
        if photoID == photo.id { reset(); return }
        reset()
        photoID = photo.id
        isLoading = true
        let token = generation
        let url = baseURL.appendingPathComponent("api/photos/\(photo.id)/developed")
        let load = load
        task = Task { [weak self] in
            do {
                let data = try await load(url)
                try Task.checkCancellation()
                let decoded = await Task.detached(priority: .userInitiated) {
                    UIImage(data: data)?.preparingForDisplay()
                }.value
                try Task.checkCancellation()
                guard let self, self.generation == token else { return }
                guard let decoded else { throw URLError(.cannotDecodeContentData) }
                self.image = decoded
                self.isLoading = false
            } catch {
                guard !Task.isCancelled, let self, self.generation == token else { return }
                self.isLoading = false
                self.errorMessage = error.localizedDescription
            }
        }
    }

    func show(photoID: Int) {
        if self.photoID != photoID { reset() }
    }

    func reset() {
        generation = UUID()
        task?.cancel()
        task = nil
        photoID = nil
        image = nil
        isLoading = false
        errorMessage = nil
    }

    deinit { task?.cancel() }
}
