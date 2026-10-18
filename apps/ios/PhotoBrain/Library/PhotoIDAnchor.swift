import Foundation

enum PhotoIDAnchor {
    static func resolve<ID: Hashable>(
        previousID: ID?,
        previousOrderedIDs: [ID],
        nextOrderedIDs: [ID]
    ) -> ID? {
        guard !nextOrderedIDs.isEmpty else { return nil }
        guard let previousID else { return nextOrderedIDs.first }

        if nextOrderedIDs.contains(previousID) {
            return previousID
        }

        guard let previousIndex = previousOrderedIDs.firstIndex(of: previousID) else {
            return nextOrderedIDs.first
        }

        return nextOrderedIDs[min(previousIndex, nextOrderedIDs.count - 1)]
    }
}
