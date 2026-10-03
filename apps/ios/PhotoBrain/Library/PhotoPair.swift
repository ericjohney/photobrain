import Foundation

/// Backs the loupe info sheet's "Pair" section: the RAW+JPEG partner's filename and format,
/// fetched with the regular photo-detail request. Any failure leaves `partner` nil so the
/// section simply stays hidden.
@MainActor
final class PhotoPairStore: ObservableObject {
    struct Partner: Equatable, Sendable {
        let id: Int
        let filename: String
        let format: String
    }

    let partnerID: Int?
    /// The server's `pairedFormat` for the open photo; preferred over re-deriving it.
    private let pairedFormat: String?
    @Published private(set) var partner: Partner?
    private let api: any PhotoBrainAPI

    init(photo: PhotoRecord, api: any PhotoBrainAPI) {
        partnerID = photo.pairedPhotoId
        pairedFormat = photo.pairedFormat.flatMap { $0.isEmpty ? nil : $0 }
        self.api = api
    }

    func load() async {
        guard let partnerID, partner?.id != partnerID else { return }
        guard let dto = try? await api.photo(id: partnerID), !Task.isCancelled else { return }
        partner = Partner(id: dto.id, filename: dto.name, format: pairedFormat ?? Self.format(of: dto) ?? "")
    }

    /// RAW partners report their `rawFormat`; standard partners their upper-cased extension.
    static func format(of dto: PhotoDTO) -> String? {
        if dto.isRaw == true, let rawFormat = dto.rawFormat, !rawFormat.isEmpty { return rawFormat }
        if dto.isRaw == true { return "RAW" }
        let ext = (dto.name as NSString).pathExtension.uppercased()
        return ext.isEmpty ? nil : ext
    }
}
