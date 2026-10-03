import SwiftUI
import UIKit

struct LibraryGrid: UIViewControllerRepresentable {
    let sections: [PhotoSection]
    @Binding var selectedID: Int?
    @Binding var selectedIDs: Set<Int>
    let isSelecting: Bool
    let resetVersion: Int
    let contentRevision: Int
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
                scrollToNewest()
                publishVisibleState()
            }
            return
        }

        let signpost = SpikeSignposts.beginSnapshot(
            itemCount: sections.reduce(into: 0) { $0 += $1.photos.count },
            sectionCount: sections.count
        )
        appliedContentRevision = contentRevision
        let nextIDs = sections.flatMap(\.photos).map(\.id)
        let nextSectionIDs = sections.map(\.id)
        let nextRecords = Dictionary(uniqueKeysWithValues: sections.flatMap(\.photos).map { ($0.id, $0) })
        let changedImageIDs = nextIDs.filter {
            recordsByID[$0] != nil
                && nextRecords[$0]?.thumbnailURL != recordsByID[$0]?.thumbnailURL
        }
        let reconfigureIDs = Set(changedImageIDs)
            .union(changedSelectionIDs)
            .filter { nextRecords[$0] != nil }

        recordsByID = nextRecords
        sectionTitles = Dictionary(uniqueKeysWithValues: sections.map { ($0.id, $0.title) })

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
            snapshot.reconfigureItems(reconfigureIDs.sorted())
        }
        collectionView.collectionViewLayout.invalidateLayout()

        dataSource.apply(snapshot, animatingDifferences: false) { [weak self] in
            SpikeSignposts.endSnapshot(signpost)
            guard let self else { return }
            if shouldReset || !didInitialPosition {
                didInitialPosition = true
                scrollToNewest()
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

    private func scrollToNewest() {
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
                    widthDimension: .fractionalWidth(1),
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
    private let imageView = UIImageView()
    private let checkmark = UIImageView(image: UIImage(systemName: "checkmark.circle.fill"))
    private let rawBadge = UILabel()
    private var loadTask: Task<Void, Never>?
    private(set) var representedID: Int?

    override init(frame: CGRect) {
        super.init(frame: frame)
        imageView.contentMode = .scaleAspectFill
        imageView.clipsToBounds = true
        imageView.translatesAutoresizingMaskIntoConstraints = false
        checkmark.tintColor = .white
        checkmark.backgroundColor = .systemBlue
        checkmark.layer.cornerRadius = 10
        checkmark.translatesAutoresizingMaskIntoConstraints = false
        rawBadge.text = "RAW"
        rawBadge.font = .preferredFont(forTextStyle: .caption2)
        rawBadge.adjustsFontForContentSizeCategory = true
        rawBadge.textColor = .white
        rawBadge.backgroundColor = UIColor.black.withAlphaComponent(0.72)
        rawBadge.layer.cornerRadius = 4
        rawBadge.clipsToBounds = true
        rawBadge.textAlignment = .center
        rawBadge.translatesAutoresizingMaskIntoConstraints = false
        contentView.addSubview(imageView)
        contentView.addSubview(checkmark)
        contentView.addSubview(rawBadge)
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
        imageView.image = nil
        checkmark.isHidden = true
        rawBadge.isHidden = true
    }

    func configure(photo: PhotoRecord, selected: Bool, loader: RedirectAwareImageLoader) {
        loadTask?.cancel()
        representedID = photo.id
        imageView.image = SyntheticThumbnail.image(id: photo.id, size: bounds.size)
        checkmark.isHidden = !selected
        rawBadge.isHidden = !photo.isRaw
        accessibilityLabel = photo.isRaw ? "\(photo.filename), RAW photo" : photo.filename
        accessibilityTraits = selected ? [.button, .selected] : [.button]

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
        }
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
