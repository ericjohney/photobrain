import SwiftUI
import UIKit

struct LibraryGrid: UIViewControllerRepresentable {
    let sections: [PhotoSection]
    @Binding var selectedID: Int?
    @Binding var selectedIDs: Set<Int>
    let isSelecting: Bool
    let resetVersion: Int
    let contentRevision: Int
    /// Open (and reset) at the first item instead of the newest edge at the bottom; for
    /// ranked lists whose best match comes first.
    var opensAtTop = false
    let onLongPress: (Int) -> Void
    let onVisibleChange: (Int?, CGFloat) -> Void
    let onRefresh: () async -> Void

    func makeUIViewController(context: Context) -> LibraryGridViewController {
        let controller = LibraryGridViewController()
        configure(controller)
        controller.apply(
            sections: sections,
            selectedIDs: selectedIDs,
            resetVersion: resetVersion,
            contentRevision: contentRevision
        )
        return controller
    }

    func updateUIViewController(_ controller: LibraryGridViewController, context: Context) {
        configure(controller)
        controller.apply(
            sections: sections,
            selectedIDs: selectedIDs,
            resetVersion: resetVersion,
            contentRevision: contentRevision
        )
    }

    private func configure(_ controller: LibraryGridViewController) {
        controller.onSelect = { id in
            if isSelecting {
                var updated = selectedIDs
                if updated.contains(id) { updated.remove(id) }
                else { updated.insert(id) }
                selectedIDs = updated
            } else {
                selectedID = id
            }
        }
        controller.onLongPress = onLongPress
        controller.opensAtTop = opensAtTop
        controller.onVisibleChange = onVisibleChange
        controller.onRefresh = onRefresh
    }
}

@MainActor
final class LibraryGridViewController: UIViewController, UICollectionViewDelegate {
    private let loader = RedirectAwareImageLoader()
    private lazy var collectionView = UICollectionView(frame: .zero, collectionViewLayout: makeLayout())
    private var dataSource: UICollectionViewDiffableDataSource<PhotoSection.ID, Int>!
    private var recordsByID: [Int: PhotoRecord] = [:]
    private var currentIDs: [Int] = []
    private var sectionIDs: [PhotoSection.ID] = []
    private var sectionTitles: [PhotoSection.ID: String] = [:]
    private var selectedIDs: Set<Int> = []
    private var appliedResetVersion = -1
    private var appliedContentRevision = -1
    private var didInitialPosition = false
    private let refreshControl = UIRefreshControl()
    private var refreshTask: Task<Void, Never>?
    var onSelect: ((Int) -> Void)?
    var onLongPress: ((Int) -> Void)?
    var onVisibleChange: ((Int?, CGFloat) -> Void)?
    var onRefresh: (() async -> Void)?
    var opensAtTop = false

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .systemBackground
        collectionView.backgroundColor = .systemBackground
        collectionView.delegate = self
        collectionView.alwaysBounceVertical = true
        collectionView.refreshControl = refreshControl
        refreshControl.addTarget(self, action: #selector(refresh), for: .valueChanged)
        collectionView.register(PhotoGridCell.self, forCellWithReuseIdentifier: PhotoGridCell.reuseIdentifier)
        collectionView.register(
            PhotoSectionHeader.self,
            forSupplementaryViewOfKind: UICollectionView.elementKindSectionHeader,
            withReuseIdentifier: PhotoSectionHeader.reuseIdentifier
        )
        let longPress = UILongPressGestureRecognizer(target: self, action: #selector(longPressed(_:)))
        collectionView.addGestureRecognizer(longPress)
        collectionView.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(collectionView)
        NSLayoutConstraint.activate([
            collectionView.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            collectionView.trailingAnchor.constraint(equalTo: view.trailingAnchor),
            collectionView.topAnchor.constraint(equalTo: view.topAnchor),
            collectionView.bottomAnchor.constraint(equalTo: view.bottomAnchor),
        ])

        dataSource = UICollectionViewDiffableDataSource<PhotoSection.ID, Int>(collectionView: collectionView) {
            [weak self] collectionView, indexPath, photoID in
            guard let self,
                  let photo = recordsByID[photoID],
                  let cell = collectionView.dequeueReusableCell(
                    withReuseIdentifier: PhotoGridCell.reuseIdentifier,
                    for: indexPath
                  ) as? PhotoGridCell else {
                return nil
            }
            cell.configure(photo: photo, selected: selectedIDs.contains(photoID), loader: loader)
            return cell
        }
        dataSource.supplementaryViewProvider = { [weak self] collectionView, kind, indexPath in
            guard kind == UICollectionView.elementKindSectionHeader,
                  let self,
                  let sectionID = dataSource.snapshot().sectionIdentifiers[safe: indexPath.section],
                  let header = collectionView.dequeueReusableSupplementaryView(
                    ofKind: kind,
                    withReuseIdentifier: PhotoSectionHeader.reuseIdentifier,
                    for: indexPath
                  ) as? PhotoSectionHeader else {
                return nil
            }
            header.setTitle(sectionTitles[sectionID] ?? "")
            return header
        }
    }

    deinit {
        refreshTask?.cancel()
    }

    func apply(
        sections: [PhotoSection],
        selectedIDs nextSelectedIDs: Set<Int>,
        resetVersion: Int,
        contentRevision: Int
    ) {
        loadViewIfNeeded()
        let changedSelectionIDs = selectedIDs.symmetricDifference(nextSelectedIDs)
        let shouldReset = appliedResetVersion != resetVersion
        selectedIDs = nextSelectedIDs
        appliedResetVersion = resetVersion

        if appliedContentRevision == contentRevision {
            guard !changedSelectionIDs.isEmpty || shouldReset else { return }
            if !changedSelectionIDs.isEmpty {
                let reconfigureIDs = changedSelectionIDs.filter { recordsByID[$0] != nil }
                if !reconfigureIDs.isEmpty {
                    var snapshot = dataSource.snapshot()
                    snapshot.reconfigureItems(reconfigureIDs.sorted())
                    dataSource.apply(snapshot, animatingDifferences: false)
                }
            }
            if shouldReset {
                scrollToInitialEdge()
                publishVisibleState()
            }
            return
        }

        appliedContentRevision = contentRevision
        let nextIDs = sections.flatMap(\.photos).map(\.id)
        let nextSectionIDs = sections.map(\.id)
        let nextRecords = Dictionary(uniqueKeysWithValues: sections.flatMap(\.photos).map { ($0.id, $0) })
        let reconfigureIDs = LibraryGridDiff.reconfigureIDs(
            previous: recordsByID,
            next: nextRecords,
            changedSelectionIDs: changedSelectionIDs
        )
        let nextTitles = Dictionary(uniqueKeysWithValues: sections.map { ($0.id, $0.title) })
        let layoutUnchanged = nextIDs == currentIDs && nextSectionIDs == sectionIDs && nextTitles == sectionTitles

        recordsByID = nextRecords
        sectionTitles = nextTitles

        // Same items in the same order (e.g. a rating/flag edit): refresh only the changed
        // cells in place so the scroll position and layout are untouched.
        if layoutUnchanged, !shouldReset, didInitialPosition {
            guard !reconfigureIDs.isEmpty else { return }
            var snapshot = dataSource.snapshot()
            snapshot.reconfigureItems(reconfigureIDs)
            dataSource.apply(snapshot, animatingDifferences: false)
            return
        }

        let signpost = SpikeSignposts.beginSnapshot(
            itemCount: nextIDs.count,
            sectionCount: sections.count
        )
        let visibleAnchorID = collectionView.indexPathsForVisibleItems.sorted().first
            .flatMap { dataSource.itemIdentifier(for: $0) }
        currentIDs = nextIDs
        sectionIDs = nextSectionIDs
        var snapshot = NSDiffableDataSourceSnapshot<PhotoSection.ID, Int>()
        for section in sections {
            snapshot.appendSections([section.id])
            snapshot.appendItems(section.photos.map(\.id), toSection: section.id)
        }
        if !reconfigureIDs.isEmpty {
            snapshot.reconfigureItems(reconfigureIDs)
        }
        collectionView.collectionViewLayout.invalidateLayout()

        dataSource.apply(snapshot, animatingDifferences: false) { [weak self] in
            SpikeSignposts.endSnapshot(signpost)
            guard let self else { return }
            if shouldReset || !didInitialPosition {
                didInitialPosition = true
                scrollToInitialEdge()
            } else if let visibleAnchorID, let indexPath = dataSource.indexPath(for: visibleAnchorID) {
                collectionView.scrollToItem(at: indexPath, at: .top, animated: false)
            }
            publishVisibleState()
        }
    }

    func collectionView(_ collectionView: UICollectionView, didSelectItemAt indexPath: IndexPath) {
        guard let id = dataSource.itemIdentifier(for: indexPath) else { return }
        onSelect?(id)
    }

    func scrollViewDidScroll(_ scrollView: UIScrollView) {
        publishVisibleState()
    }

    @objc private func refresh() {
        refreshTask?.cancel()
        refreshTask = Task { [weak self] in
            await self?.onRefresh?()
            guard !Task.isCancelled else { return }
            self?.refreshControl.endRefreshing()
        }
    }

    @objc private func longPressed(_ recognizer: UILongPressGestureRecognizer) {
        guard recognizer.state == .began else { return }
        let point = recognizer.location(in: collectionView)
        guard let indexPath = collectionView.indexPathForItem(at: point),
              let id = dataSource.itemIdentifier(for: indexPath) else { return }
        onLongPress?(id)
    }

    private func scrollToInitialEdge() {
        if opensAtTop {
            collectionView.setContentOffset(
                CGPoint(x: 0, y: -collectionView.adjustedContentInset.top),
                animated: false
            )
            return
        }
        guard let lastID = currentIDs.last, let indexPath = dataSource.indexPath(for: lastID) else { return }
        collectionView.scrollToItem(at: indexPath, at: .bottom, animated: false)
    }

    private func publishVisibleState() {
        let visible = collectionView.indexPathsForVisibleItems.sorted()
        let firstID = visible.first.flatMap { dataSource.itemIdentifier(for: $0) }
        let visibleNewestEdge = collectionView.contentOffset.y
            + collectionView.bounds.height
            - collectionView.adjustedContentInset.bottom
        let contentNewestEdge = collectionView.contentSize.height
        onVisibleChange?(firstID, max(0, contentNewestEdge - visibleNewestEdge))
    }

    private func makeLayout() -> UICollectionViewLayout {
        UICollectionViewCompositionalLayout { [weak self] sectionIndex, environment in
            let width = environment.container.effectiveContentSize.width
            let columns: Int
            switch width {
            case ..<560: columns = 5
            case ..<768: columns = 6
            case ..<1_024: columns = 7
            default: columns = 8
            }
            let item = NSCollectionLayoutItem(
                layoutSize: NSCollectionLayoutSize(
                    widthDimension: .fractionalWidth(1 / CGFloat(columns)),
                    heightDimension: .fractionalHeight(1)
                )
            )
            item.contentInsets = NSDirectionalEdgeInsets(top: 0.5, leading: 0.5, bottom: 0.5, trailing: 0.5)
            let group = NSCollectionLayoutGroup.horizontal(
                layoutSize: NSCollectionLayoutSize(
                    widthDimension: .fractionalWidth(1),
                    heightDimension: .fractionalWidth(1 / CGFloat(columns))
                ),
                repeatingSubitem: item,
                count: columns
            )
            let section = NSCollectionLayoutSection(group: group)
            if let self,
               let sectionID = sectionIDs[safe: sectionIndex],
               !(sectionTitles[sectionID] ?? "").isEmpty {
                section.boundarySupplementaryItems = [
                    NSCollectionLayoutBoundarySupplementaryItem(
                        layoutSize: NSCollectionLayoutSize(
                            widthDimension: .fractionalWidth(1),
                            heightDimension: .estimated(38)
                        ),
                        elementKind: UICollectionView.elementKindSectionHeader,
                        alignment: .top
                    ),
                ]
            }
            return section
        }
    }
}

/// Decides which already-displayed grid cells must be reconfigured between two content revisions.
enum LibraryGridDiff {
    /// Items present in both revisions whose rendered content changed, plus items whose
    /// selection changed, in ascending ID order. New items are configured on insertion.
    static func reconfigureIDs(
        previous: [Int: PhotoRecord],
        next: [Int: PhotoRecord],
        changedSelectionIDs: Set<Int>
    ) -> [Int] {
        var ids: Set<Int> = changedSelectionIDs.filter { previous[$0] != nil && next[$0] != nil }
        for (id, record) in next {
            guard let old = previous[id], rendersDifferently(old, record) else { continue }
            ids.insert(id)
        }
        return ids.sorted()
    }

    /// Every field `PhotoGridCell.configure` draws: image, format badge, label, rating, and flag.
    static func rendersDifferently(_ old: PhotoRecord, _ new: PhotoRecord) -> Bool {
        old.thumbnailURL != new.thumbnailURL
            || old.rating != new.rating
            || old.flag != new.flag
            || old.isRaw != new.isRaw
            || old.rawFormat != new.rawFormat
            || old.pairedPhotoId != new.pairedPhotoId
            || old.pairedFormat != new.pairedFormat
            || old.filename != new.filename
    }
}

enum CurationBadgeText {
    /// Compact grid badge text, e.g. "★3"; nil when unrated.
    static func stars(_ rating: Int) -> String? {
        rating > 0 ? "★\(rating)" : nil
    }

    /// Spoken suffix for a photo's curation, e.g. ", 3 stars, Pick".
    static func accessibilitySuffix(rating: Int, flag: PhotoFlag?) -> String {
        var parts: [String] = []
        if rating > 0 { parts.append(rating == 1 ? "1 star" : "\(rating) stars") }
        switch flag {
        case .pick: parts.append("Pick")
        case .reject: parts.append("Rejected")
        case nil: break
        }
        return parts.map { ", \($0)" }.joined()
    }
}

private extension Collection {
    subscript(safe index: Index) -> Element? {
        indices.contains(index) ? self[index] : nil
    }
}

@MainActor
private final class PhotoSectionHeader: UICollectionReusableView {
    static let reuseIdentifier = "PhotoSectionHeader"
    private let label = UILabel()

    override init(frame: CGRect) {
        super.init(frame: frame)
        backgroundColor = .systemBackground
        label.font = .preferredFont(forTextStyle: .headline)
        label.adjustsFontForContentSizeCategory = true
        label.translatesAutoresizingMaskIntoConstraints = false
        addSubview(label)
        NSLayoutConstraint.activate([
            label.leadingAnchor.constraint(equalTo: leadingAnchor, constant: 10),
            label.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -10),
            label.topAnchor.constraint(equalTo: topAnchor, constant: 8),
            label.bottomAnchor.constraint(equalTo: bottomAnchor, constant: -6),
        ])
    }

    required init?(coder: NSCoder) {
        fatalError("init(coder:) has not been implemented")
    }

    func setTitle(_ title: String) {
        label.text = title
        accessibilityLabel = title
    }
}

@MainActor
private final class PhotoGridCell: UICollectionViewCell {
    static let reuseIdentifier = "PhotoGridCell"
    private static let rejectedAlpha: CGFloat = 0.35
    private let imageView = UIImageView()
    private let checkmark = UIImageView(image: UIImage(systemName: "checkmark.circle.fill"))
    private let rawBadge = UILabel()
    private let curationBadge = UIStackView()
    /// Duration (video) or LIVE badge, stacked under the curation badge at the bottom right.
    private let mediaBadge = UIStackView()
    private let mediaBadgeIcon = UIImageView()
    private let mediaBadgeLabel = UILabel()
    private let trailingBadges = UIStackView()
    private let ratingLabel = UILabel()
    private let flagView = UIImageView()
    private var loadTask: Task<Void, Never>?
    private(set) var representedID: Int?
    /// Thumbnail URL whose image is currently displayed; lets curation/selection
    /// reconfigures keep the loaded image instead of flashing the placeholder.
    private var displayedURL: URL?

    override init(frame: CGRect) {
        super.init(frame: frame)
        imageView.contentMode = .scaleAspectFill
        imageView.clipsToBounds = true
        imageView.translatesAutoresizingMaskIntoConstraints = false
        checkmark.tintColor = .white
        checkmark.backgroundColor = .systemBlue
        checkmark.layer.cornerRadius = 10
        checkmark.translatesAutoresizingMaskIntoConstraints = false
        rawBadge.font = .preferredFont(forTextStyle: .caption2)
        rawBadge.adjustsFontForContentSizeCategory = true
        rawBadge.textColor = .white
        rawBadge.backgroundColor = UIColor.black.withAlphaComponent(0.72)
        rawBadge.layer.cornerRadius = 4
        rawBadge.clipsToBounds = true
        rawBadge.textAlignment = .center
        rawBadge.translatesAutoresizingMaskIntoConstraints = false
        ratingLabel.font = .preferredFont(forTextStyle: .caption2)
        ratingLabel.adjustsFontForContentSizeCategory = true
        ratingLabel.textColor = .white
        flagView.contentMode = .scaleAspectFit
        flagView.preferredSymbolConfiguration = UIImage.SymbolConfiguration(textStyle: .caption2)
        curationBadge.axis = .horizontal
        curationBadge.spacing = 2
        curationBadge.alignment = .center
        curationBadge.isLayoutMarginsRelativeArrangement = true
        curationBadge.directionalLayoutMargins = NSDirectionalEdgeInsets(top: 1, leading: 4, bottom: 1, trailing: 4)
        curationBadge.backgroundColor = UIColor.black.withAlphaComponent(0.72)
        curationBadge.layer.cornerRadius = 4
        curationBadge.clipsToBounds = true
        curationBadge.translatesAutoresizingMaskIntoConstraints = false
        curationBadge.addArrangedSubview(ratingLabel)
        curationBadge.addArrangedSubview(flagView)
        mediaBadgeLabel.font = .monospacedDigitSystemFont(
            ofSize: UIFont.preferredFont(forTextStyle: .caption2).pointSize,
            weight: .semibold
        )
        mediaBadgeLabel.adjustsFontForContentSizeCategory = true
        mediaBadgeLabel.textColor = .white
        mediaBadgeIcon.tintColor = .white
        mediaBadgeIcon.contentMode = .scaleAspectFit
        mediaBadgeIcon.preferredSymbolConfiguration = UIImage.SymbolConfiguration(textStyle: .caption2)
        mediaBadge.axis = .horizontal
        mediaBadge.spacing = 2
        mediaBadge.alignment = .center
        mediaBadge.isLayoutMarginsRelativeArrangement = true
        mediaBadge.directionalLayoutMargins = NSDirectionalEdgeInsets(top: 1, leading: 4, bottom: 1, trailing: 4)
        mediaBadge.backgroundColor = UIColor.black.withAlphaComponent(0.72)
        mediaBadge.layer.cornerRadius = 4
        mediaBadge.clipsToBounds = true
        mediaBadge.addArrangedSubview(mediaBadgeIcon)
        mediaBadge.addArrangedSubview(mediaBadgeLabel)
        mediaBadge.isHidden = true
        trailingBadges.axis = .vertical
        trailingBadges.alignment = .trailing
        trailingBadges.spacing = 2
        trailingBadges.translatesAutoresizingMaskIntoConstraints = false
        trailingBadges.addArrangedSubview(curationBadge)
        trailingBadges.addArrangedSubview(mediaBadge)
        contentView.addSubview(imageView)
        contentView.addSubview(checkmark)
        contentView.addSubview(rawBadge)
        contentView.addSubview(trailingBadges)
        NSLayoutConstraint.activate([
            imageView.leadingAnchor.constraint(equalTo: contentView.leadingAnchor),
            imageView.trailingAnchor.constraint(equalTo: contentView.trailingAnchor),
            imageView.topAnchor.constraint(equalTo: contentView.topAnchor),
            imageView.bottomAnchor.constraint(equalTo: contentView.bottomAnchor),
            checkmark.trailingAnchor.constraint(equalTo: contentView.trailingAnchor, constant: -5),
            checkmark.topAnchor.constraint(equalTo: contentView.topAnchor, constant: 5),
            checkmark.widthAnchor.constraint(equalToConstant: 20),
            checkmark.heightAnchor.constraint(equalToConstant: 20),
            rawBadge.leadingAnchor.constraint(equalTo: contentView.leadingAnchor, constant: 5),
            rawBadge.bottomAnchor.constraint(equalTo: contentView.bottomAnchor, constant: -5),
            rawBadge.widthAnchor.constraint(greaterThanOrEqualToConstant: 34),
            rawBadge.heightAnchor.constraint(greaterThanOrEqualToConstant: 20),
            trailingBadges.trailingAnchor.constraint(equalTo: contentView.trailingAnchor, constant: -4),
            trailingBadges.bottomAnchor.constraint(equalTo: contentView.bottomAnchor, constant: -4),
            trailingBadges.leadingAnchor.constraint(greaterThanOrEqualTo: contentView.leadingAnchor, constant: 4),
        ])
        isAccessibilityElement = true
    }

    required init?(coder: NSCoder) {
        fatalError("init(coder:) has not been implemented")
    }

    override func prepareForReuse() {
        super.prepareForReuse()
        loadTask?.cancel()
        loadTask = nil
        representedID = nil
        displayedURL = nil
        imageView.image = nil
        imageView.alpha = 1
        checkmark.isHidden = true
        rawBadge.isHidden = true
        curationBadge.isHidden = true
        mediaBadge.isHidden = true
    }

    func configure(photo: PhotoRecord, selected: Bool, loader: RedirectAwareImageLoader) {
        let keepsImage = representedID == photo.id && displayedURL == photo.thumbnailURL
        representedID = photo.id
        imageView.alpha = photo.isRejected ? Self.rejectedAlpha : 1
        checkmark.isHidden = !selected
        let badge = photo.formatBadge
        rawBadge.text = badge
        rawBadge.isHidden = badge == nil
        configureCurationBadge(rating: photo.rating, flag: photo.flag)
        configureMediaBadge(photo.mediaBadge)
        let base = photo.accessibilityName
        accessibilityLabel = base + CurationBadgeText.accessibilitySuffix(rating: photo.rating, flag: photo.flag)
        accessibilityTraits = selected ? [.button, .selected] : [.button]

        guard !keepsImage else { return }
        loadTask?.cancel()
        displayedURL = nil
        imageView.image = SyntheticThumbnail.image(id: photo.id, size: bounds.size)
        guard photo.thumbnailURL.host != "photos.example.invalid" else { return }
        loadTask = Task { @MainActor [weak self] in
            let target = self?.bounds.size ?? CGSize(width: 160, height: 160)
            guard let image = try? await loader.image(
                for: photo,
                url: photo.thumbnailURL,
                targetSize: target
            ),
                  !Task.isCancelled,
                  self?.representedID == photo.id else { return }
            self?.imageView.image = image
            self?.displayedURL = photo.thumbnailURL
        }
    }

    private func configureMediaBadge(_ badge: MediaBadge?) {
        guard let badge else {
            mediaBadge.isHidden = true
            return
        }
        mediaBadgeIcon.image = UIImage(systemName: badge.systemImage)
        mediaBadgeLabel.text = badge.text
        mediaBadge.isHidden = false
    }

    private func configureCurationBadge(rating: Int, flag: PhotoFlag?) {
        let stars = CurationBadgeText.stars(rating)
        ratingLabel.text = stars
        ratingLabel.isHidden = stars == nil
        switch flag {
        case .pick:
            flagView.image = UIImage(systemName: "flag.fill")
            flagView.tintColor = .white
            flagView.isHidden = false
        case .reject:
            flagView.image = UIImage(systemName: "xmark.circle.fill")
            flagView.tintColor = .systemRed
            flagView.isHidden = false
        case nil:
            flagView.image = nil
            flagView.isHidden = true
        }
        curationBadge.isHidden = stars == nil && flag == nil
    }
}

enum SyntheticThumbnail {
    static func color(id: Int) -> UIColor {
        UIColor(
            hue: CGFloat((id * 47) % 360) / 360,
            saturation: 0.48 + CGFloat(id % 4) * 0.08,
            brightness: 0.58 + CGFloat(id % 3) * 0.1,
            alpha: 1
        )
    }

    static func image(id: Int, size: CGSize) -> UIImage {
        let renderSize = CGSize(width: max(size.width, 8), height: max(size.height, 8))
        let renderer = UIGraphicsImageRenderer(size: renderSize)
        return renderer.image { context in
            color(id: id).setFill()
            context.fill(CGRect(origin: .zero, size: renderSize))
        }
    }
}
