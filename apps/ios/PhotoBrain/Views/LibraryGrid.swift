import SwiftUI
import UIKit

struct LibraryGrid: UIViewControllerRepresentable {
    let sections: [PhotoSection]
    @Binding var selectedID: LibraryEntryID?
    @Binding var selectedIDs: Set<LibraryEntryID>
    let isSelecting: Bool
    let resetVersion: Int
    let contentRevision: Int
    /// Open (and reset) at the first item instead of the newest edge at the bottom; for
    /// ranked lists whose best match comes first.
    var opensAtTop = false
    let onLongPress: (LibraryEntryID) -> Void
    let onVisibleChange: (LibraryEntryID?, CGFloat) -> Void
    /// Zoom transition for this grid's loupe; selection then presents without the cover animation.
    var transition: LoupeZoomTransition?
    /// Phone column count (3, 5, or 9); nil keeps the width-based default. Wider screens
    /// scale it up. Pinching steps it and reports the new value.
    var columns: Int?
    var onPinchColumns: ((Int) -> Void)?
    /// Photos-style full-bleed library: the grid runs under the status bar and floating
    /// chrome, with these insets, a dark top scrim, and section headers that scroll away.
    /// Nil keeps the system's automatic insets and pinned headers.
    var fullBleedInsets: EdgeInsets?
    /// Bumped to scroll back to the newest photos (the collapsed bar's Library button).
    var scrollToNewestVersion = 0
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
        transition?.source = controller
        controller.onLongPress = onLongPress
        controller.opensAtTop = opensAtTop
        controller.onVisibleChange = onVisibleChange
        controller.onRefresh = onRefresh
        controller.onPinchColumns = onPinchColumns
        controller.setPhoneColumns(columns)
        controller.setFullBleedInsets(fullBleedInsets.map {
            UIEdgeInsets(top: $0.top, left: 0, bottom: $0.bottom, right: 0)
        })
        controller.scrollToNewest(version: scrollToNewestVersion)
    }
}

@MainActor
final class LibraryGridViewController: UIViewController, UICollectionViewDelegate, LoupeTransitionSource {
    private let loader = RedirectAwareImageLoader()
    private lazy var collectionView = UICollectionView(frame: .zero, collectionViewLayout: makeLayout())
    private var dataSource: UICollectionViewDiffableDataSource<PhotoSection.ID, LibraryEntryID>!
    private var recordsByID: [LibraryEntryID: LibraryEntry] = [:]
    private var currentIDs: [LibraryEntryID] = []
    private var sectionIDs: [PhotoSection.ID] = []
    private var sectionTitles: [PhotoSection.ID: String] = [:]
    private var sectionDetails: [PhotoSection.ID: String] = [:]
    private var selectedIDs: Set<LibraryEntryID> = []
    private var appliedResetVersion = -1
    private var appliedContentRevision = -1
    private var pendingContentReset = false
    private var didInitialPosition = false
    private let refreshControl = UIRefreshControl()
    private var refreshTask: Task<Void, Never>?
    var onSelect: ((LibraryEntryID) -> Void)?
    var onLongPress: ((LibraryEntryID) -> Void)?
    var onVisibleChange: ((LibraryEntryID?, CGFloat) -> Void)?
    var onRefresh: (() async -> Void)?
    var opensAtTop = false
    /// Photo whose cell is hidden while the loupe flies it in or out.
    private var loupeHiddenID: LibraryEntryID?
    var onPinchColumns: ((Int) -> Void)?
    private let topScrim = GradientScrimView()
    private var phoneColumns: Int?
    private var fullBleed: UIEdgeInsets?
    private var pinchHandled = false
    /// The first positioning ran before the grid had a size; redo it on the next layout.
    private var needsInitialEdgeScroll = false

    override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews()
        guard needsInitialEdgeScroll, collectionView.bounds.height > 0 else { return }
        needsInitialEdgeScroll = false
        collectionView.layoutIfNeeded()
        scrollToInitialEdge()
        publishVisibleState()
    }

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
        let pinch = UIPinchGestureRecognizer(target: self, action: #selector(pinched(_:)))
        collectionView.addGestureRecognizer(pinch)

        collectionView.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(collectionView)
        NSLayoutConstraint.activate([
            collectionView.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            collectionView.trailingAnchor.constraint(equalTo: view.trailingAnchor),
            collectionView.topAnchor.constraint(equalTo: view.topAnchor),
            collectionView.bottomAnchor.constraint(equalTo: view.bottomAnchor),
        ])
        topScrim.translatesAutoresizingMaskIntoConstraints = false
        topScrim.isUserInteractionEnabled = false
        topScrim.isHidden = true
        view.addSubview(topScrim)
        NSLayoutConstraint.activate([
            topScrim.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            topScrim.trailingAnchor.constraint(equalTo: view.trailingAnchor),
            topScrim.topAnchor.constraint(equalTo: view.topAnchor),
            topScrim.heightAnchor.constraint(equalToConstant: 170),
        ])

        dataSource = UICollectionViewDiffableDataSource<PhotoSection.ID, LibraryEntryID>(collectionView: collectionView) {
            [weak self] collectionView, indexPath, photoID in
            guard let self,
                  let photo = recordsByID[photoID],
                  let cell = collectionView.dequeueReusableCell(
                    withReuseIdentifier: PhotoGridCell.reuseIdentifier,
                    for: indexPath
                  ) as? PhotoGridCell else {
                return nil
            }
            cell.configure(item: photo, selected: selectedIDs.contains(photoID), loader: loader)
            cell.contentView.alpha = loupeHiddenID == photoID ? 0 : 1
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
            header.setTitle(sectionTitles[sectionID] ?? "", detail: sectionDetails[sectionID])
            return header
        }
    }

    deinit {
        refreshTask?.cancel()
    }

    func apply(
        sections: [PhotoSection],
        selectedIDs nextSelectedIDs: Set<LibraryEntryID>,
        resetVersion: Int,
        contentRevision: Int
    ) {
        loadViewIfNeeded()
        let changedSelectionIDs = selectedIDs.symmetricDifference(nextSelectedIDs)
        let resetRequested = appliedResetVersion != resetVersion
        selectedIDs = nextSelectedIDs
        appliedResetVersion = resetVersion
        // A filter change resets before its reload lands; keep the reset pending so the new
        // content opens at its newest edge too, instead of at the old list's offset.
        if resetRequested { pendingContentReset = true }
        let shouldReset = resetRequested || (pendingContentReset && appliedContentRevision != contentRevision)

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
        pendingContentReset = false
        let nextIDs = sections.flatMap(\.items).map(\.id)
        let nextSectionIDs = sections.map(\.id)
        let nextRecords = Dictionary(sections.flatMap(\.items).map { ($0.id, $0) }, uniquingKeysWith: { first, _ in first })
        let reconfigureIDs = LibraryGridDiff.reconfigureIDs(
            previous: recordsByID,
            next: nextRecords,
            changedSelectionIDs: changedSelectionIDs
        )
        let nextTitles = Dictionary(uniqueKeysWithValues: sections.map { ($0.id, $0.title) })
        let nextDetails = Dictionary(uniqueKeysWithValues: sections.compactMap { section in
            section.detail.map { (section.id, $0) }
        })
        let layoutUnchanged = nextIDs == currentIDs && nextSectionIDs == sectionIDs
            && nextTitles == sectionTitles && nextDetails == sectionDetails

        recordsByID = nextRecords
        sectionTitles = nextTitles
        sectionDetails = nextDetails

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
        // A grid resting at its newest edge stays there when sections change (e.g. event
        // titles arriving after launch); anchoring the top row would scroll it back in time.
        let wasAtNewestEdge = didInitialPosition && !opensAtTop && distanceFromNewest <= 2
        currentIDs = nextIDs
        sectionIDs = nextSectionIDs
        var snapshot = NSDiffableDataSourceSnapshot<PhotoSection.ID, LibraryEntryID>()
        for section in sections {
            snapshot.appendSections([section.id])
            snapshot.appendItems(section.items.map(\.id), toSection: section.id)
        }
        if !reconfigureIDs.isEmpty {
            snapshot.reconfigureItems(reconfigureIDs)
        }
        collectionView.collectionViewLayout.invalidateLayout()

        dataSource.apply(snapshot, animatingDifferences: false) { [weak self] in
            SpikeSignposts.endSnapshot(signpost)
            guard let self else { return }
            if shouldReset || !didInitialPosition || wasAtNewestEdge {
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

    // MARK: Full bleed

    func setFullBleedInsets(_ insets: UIEdgeInsets?) {
        loadViewIfNeeded()
        guard insets != fullBleed else { return }
        let wasFullBleed = fullBleed != nil
        let wasAtNewest = distanceFromNewest <= 2
        fullBleed = insets
        if let insets {
            collectionView.contentInsetAdjustmentBehavior = .never
            collectionView.contentInset = insets
            collectionView.verticalScrollIndicatorInsets = insets
            if #available(iOS 26.0, *) {
                // Photos darkens the top edge instead of frosting it, keeping the white status
                // bar and title readable over photos.
                collectionView.topEdgeEffect.isHidden = true
                collectionView.bottomEdgeEffect.isHidden = true
            }
        } else {
            collectionView.contentInsetAdjustmentBehavior = .automatic
            collectionView.contentInset = .zero
            collectionView.verticalScrollIndicatorInsets = .zero
        }
        topScrim.isHidden = insets == nil
        if wasFullBleed != (insets != nil) {
            collectionView.collectionViewLayout.invalidateLayout()
        }
        if didInitialPosition, wasAtNewest, !opensAtTop {
            collectionView.layoutIfNeeded()
            scrollToInitialEdge()
        }
        publishVisibleState()
    }

    private var appliedScrollToNewest = 0

    func scrollToNewest(version: Int) {
        guard version != appliedScrollToNewest else { return }
        appliedScrollToNewest = version
        let bottom = collectionView.contentSize.height - collectionView.bounds.height
            + collectionView.adjustedContentInset.bottom
        collectionView.setContentOffset(CGPoint(x: 0, y: max(-collectionView.adjustedContentInset.top, bottom)), animated: true)
    }

    private var distanceFromNewest: CGFloat {
        let visibleNewestEdge = collectionView.contentOffset.y
            + collectionView.bounds.height
            - collectionView.adjustedContentInset.bottom
        return max(0, collectionView.contentSize.height - visibleNewestEdge)
    }

    // MARK: Column zoom

    static let phoneColumnSteps = [3, 5, 9]

    /// The next denser (`pinchingIn`) or looser column count, or nil at the end of the range.
    static func nextColumns(from current: Int, pinchingIn: Bool) -> Int? {
        let steps = phoneColumnSteps
        let index = steps.firstIndex { $0 >= current } ?? steps.count - 1
        let next = pinchingIn ? index + 1 : index - 1
        return steps.indices.contains(next) ? steps[next] : nil
    }

    func setPhoneColumns(_ columns: Int?) {
        loadViewIfNeeded()
        guard columns != phoneColumns else { return }
        let animated = phoneColumns != nil && view.window != nil
        phoneColumns = columns
        let anchor = pinchAnchorID ?? collectionView.indexPathsForVisibleItems.sorted().dropFirst(
            collectionView.indexPathsForVisibleItems.count / 2
        ).first.flatMap { dataSource.itemIdentifier(for: $0) }
        pinchAnchorID = nil
        let layout = makeLayout()
        collectionView.setCollectionViewLayout(layout, animated: animated) { [weak self] _ in
            self?.scrollToAnchor(anchor)
        }
        if !animated { scrollToAnchor(anchor) }
    }

    private var pinchAnchorID: LibraryEntryID?

    private func scrollToAnchor(_ id: LibraryEntryID?) {
        guard let id, let indexPath = dataSource.indexPath(for: id) else { return }
        collectionView.scrollToItem(at: indexPath, at: .centeredVertically, animated: false)
        publishVisibleState()
    }

    @objc private func pinched(_ pinch: UIPinchGestureRecognizer) {
        switch pinch.state {
        case .began:
            pinchHandled = false
        case .changed:
            guard !pinchHandled, abs(pinch.scale - 1) > 0.2 else { return }
            pinchHandled = true
            let current = phoneColumns ?? 5
            guard let next = Self.nextColumns(from: current, pinchingIn: pinch.scale < 1) else { return }
            let point = pinch.location(in: collectionView)
            pinchAnchorID = collectionView.indexPathForItem(at: point).flatMap { dataSource.itemIdentifier(for: $0) }
            UISelectionFeedbackGenerator().selectionChanged()
            onPinchColumns?(next)
        default:
            break
        }
    }

    // MARK: Loupe transition source

    var loupeContainerBounds: CGRect {
        view.window?.bounds ?? UIScreen.main.bounds
    }

    func loupeSourceFrame(for id: LibraryEntryID) -> CGRect? {
        guard view.window != nil, let indexPath = dataSource.indexPath(for: id) else { return nil }
        guard var attributes = collectionView.layoutAttributesForItem(at: indexPath) else { return nil }
        let visible = collectionView.bounds.inset(by: collectionView.adjustedContentInset)
        if !visible.contains(attributes.frame) {
            collectionView.scrollToItem(at: indexPath, at: .centeredVertically, animated: false)
            collectionView.layoutIfNeeded()
            attributes = collectionView.layoutAttributesForItem(at: indexPath) ?? attributes
        }
        return collectionView.convert(attributes.frame, to: nil)
    }

    func loupeSourceImage(for id: LibraryEntryID) -> UIImage? {
        guard let indexPath = dataSource.indexPath(for: id),
              let cell = collectionView.cellForItem(at: indexPath) as? PhotoGridCell else { return nil }
        return cell.loadedImage
    }

    func setLoupeHiddenID(_ id: LibraryEntryID?) {
        let previous = loupeHiddenID
        loupeHiddenID = id
        for changed in [previous, id].compactMap({ $0 }) {
            guard let indexPath = dataSource.indexPath(for: changed),
                  let cell = collectionView.cellForItem(at: indexPath) else { continue }
            cell.contentView.alpha = changed == id ? 0 : 1
        }
    }

    private func scrollToInitialEdge() {
        guard collectionView.bounds.height > 0, view.window != nil else {
            needsInitialEdgeScroll = true
            view.setNeedsLayout()
            return
        }
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
        onVisibleChange?(firstID, distanceFromNewest)
    }

    /// Phone widths use the chosen count; wider screens add columns in proportion.
    static func columnCount(width: CGFloat, phoneColumns: Int?) -> Int {
        guard let phoneColumns else {
            switch width {
            case ..<560: return 4
            case ..<768: return 6
            case ..<1_024: return 7
            default: return 8
            }
        }
        guard width >= 560 else { return phoneColumns }
        return max(phoneColumns, Int((CGFloat(phoneColumns) * width / 400).rounded()))
    }

    private func makeLayout() -> UICollectionViewLayout {
        UICollectionViewCompositionalLayout { [weak self] sectionIndex, environment in
            let width = environment.container.effectiveContentSize.width
            let columns = Self.columnCount(width: width, phoneColumns: self?.phoneColumns)
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
                let header = NSCollectionLayoutBoundarySupplementaryItem(
                    layoutSize: NSCollectionLayoutSize(
                        widthDimension: .fractionalWidth(1),
                        heightDimension: .estimated(44)
                    ),
                    elementKind: UICollectionView.elementKindSectionHeader,
                    alignment: .top
                )
                // Under floating chrome (Photos), headers scroll with their photos.
                header.pinToVisibleBounds = self.fullBleed == nil
                section.boundarySupplementaryItems = [header]
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
        previous: [LibraryEntryID: LibraryEntry],
        next: [LibraryEntryID: LibraryEntry],
        changedSelectionIDs: Set<LibraryEntryID>
    ) -> [LibraryEntryID] {
        var ids: Set<LibraryEntryID> = changedSelectionIDs.filter { previous[$0] != nil && next[$0] != nil }
        for (id, item) in next {
            guard let old = previous[id], rendersDifferently(old, item) else { continue }
            ids.insert(id)
        }
        return ids.sorted()
    }

    /// Server-record convenience: records keyed by photo id.
    static func reconfigureIDs(
        previous: [Int: PhotoRecord],
        next: [Int: PhotoRecord],
        changedSelectionIDs: Set<Int>
    ) -> [Int] {
        reconfigureIDs(
            previous: Dictionary(uniqueKeysWithValues: previous.map { (LibraryEntryID.remote($0.key), LibraryEntry(remote: $0.value)) }),
            next: Dictionary(uniqueKeysWithValues: next.map { (LibraryEntryID.remote($0.key), LibraryEntry(remote: $0.value)) }),
            changedSelectionIDs: Set(changedSelectionIDs.map(LibraryEntryID.remote))
        ).compactMap(\.remotePhotoID)
    }

    /// Every field `PhotoGridCell.configure` draws.
    static func rendersDifferently(_ old: LibraryEntry, _ new: LibraryEntry) -> Bool {
        switch (old.remote, new.remote) {
        case let (oldRecord?, newRecord?):
            if rendersDifferently(oldRecord, newRecord) { return true }
        case (nil, nil):
            break
        default:
            return true
        }
        return old.backupState != new.backupState || old.local != new.local
    }

    /// Every field `PhotoGridCell.configure` draws for a server photo: image, format badge,
    /// label, rating, and flag.
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
    private let background = UIVisualEffectView(effect: UIBlurEffect(style: .systemChromeMaterial))
    private let label = UILabel()
    private let detailLabel = UILabel()

    override init(frame: CGRect) {
        super.init(frame: frame)
        background.translatesAutoresizingMaskIntoConstraints = false
        addSubview(background)
        label.font = UIFontMetrics(forTextStyle: .headline)
            .scaledFont(for: .systemFont(ofSize: 17, weight: .bold))
        label.adjustsFontForContentSizeCategory = true
        label.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        detailLabel.font = .preferredFont(forTextStyle: .footnote)
        detailLabel.adjustsFontForContentSizeCategory = true
        detailLabel.textColor = .secondaryLabel
        detailLabel.setContentHuggingPriority(.required, for: .horizontal)
        detailLabel.setContentCompressionResistancePriority(.required, for: .horizontal)
        let stack = UIStackView(arrangedSubviews: [label, detailLabel])
        stack.axis = .horizontal
        stack.alignment = .firstBaseline
        stack.spacing = 8
        stack.translatesAutoresizingMaskIntoConstraints = false
        addSubview(stack)
        NSLayoutConstraint.activate([
            background.leadingAnchor.constraint(equalTo: leadingAnchor),
            background.trailingAnchor.constraint(equalTo: trailingAnchor),
            background.topAnchor.constraint(equalTo: topAnchor),
            background.bottomAnchor.constraint(equalTo: bottomAnchor),
            stack.leadingAnchor.constraint(equalTo: layoutMarginsGuide.leadingAnchor),
            stack.trailingAnchor.constraint(equalTo: layoutMarginsGuide.trailingAnchor),
            stack.topAnchor.constraint(equalTo: topAnchor, constant: 10),
            stack.bottomAnchor.constraint(equalTo: bottomAnchor, constant: -8),
        ])
        directionalLayoutMargins = NSDirectionalEdgeInsets(top: 0, leading: 16, bottom: 0, trailing: 16)
        isAccessibilityElement = true
        accessibilityTraits = .header
    }

    required init?(coder: NSCoder) {
        fatalError("init(coder:) has not been implemented")
    }

    override func traitCollectionDidChange(_ previousTraitCollection: UITraitCollection?) {
        super.traitCollectionDidChange(previousTraitCollection)
        applyBackground()
    }

    /// Blurred unless Reduce Transparency is on or the app runs under UI tests.
    private func applyBackground() {
        let opaque = UIAccessibility.isReduceTransparencyEnabled || UITestMode.isActive
        background.isHidden = opaque
        backgroundColor = opaque ? .systemBackground : .clear
    }

    func setTitle(_ title: String, detail: String?) {
        label.text = title
        detailLabel.text = detail
        detailLabel.isHidden = detail == nil
        accessibilityLabel = detail.map { "\(title), \($0)" } ?? title
        applyBackground()
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
    private(set) var representedID: LibraryEntryID?
    /// Image source whose image is currently displayed; lets curation/selection reconfigures
    /// keep the loaded image instead of flashing the placeholder.
    private var displayedKey: String?
    /// Device-only backup state (top left): not backed up, queued, uploading, failed.
    private let backupBadge = UIImageView()

    /// The decoded thumbnail, or nil while the placeholder shows.
    var loadedImage: UIImage? {
        displayedKey == nil ? nil : imageView.image
    }

    override init(frame: CGRect) {
        super.init(frame: frame)
        imageView.contentMode = .scaleAspectFill
        imageView.clipsToBounds = true
        imageView.backgroundColor = .secondarySystemFill
        imageView.translatesAutoresizingMaskIntoConstraints = false
        checkmark.tintColor = .white
        checkmark.backgroundColor = .tintColor
        checkmark.layer.cornerRadius = 10
        checkmark.translatesAutoresizingMaskIntoConstraints = false
        rawBadge.font = UIFontMetrics(forTextStyle: .caption2)
            .scaledFont(for: .systemFont(ofSize: 10, weight: .semibold))
        rawBadge.adjustsFontForContentSizeCategory = true
        rawBadge.textColor = .white
        rawBadge.backgroundColor = PBColor.uiBadgeBackground
        rawBadge.layer.cornerRadius = PBRadius.badge
        rawBadge.layer.cornerCurve = .continuous
        rawBadge.clipsToBounds = true
        rawBadge.textAlignment = .center
        rawBadge.translatesAutoresizingMaskIntoConstraints = false
        ratingLabel.font = UIFontMetrics(forTextStyle: .caption2)
            .scaledFont(for: .systemFont(ofSize: 10, weight: .semibold))
        ratingLabel.adjustsFontForContentSizeCategory = true
        ratingLabel.textColor = .white
        flagView.contentMode = .scaleAspectFit
        flagView.preferredSymbolConfiguration = UIImage.SymbolConfiguration(textStyle: .caption2)
        curationBadge.axis = .horizontal
        curationBadge.spacing = 2
        curationBadge.alignment = .center
        curationBadge.isLayoutMarginsRelativeArrangement = true
        curationBadge.directionalLayoutMargins = NSDirectionalEdgeInsets(top: 1, leading: 4, bottom: 1, trailing: 4)
        curationBadge.backgroundColor = PBColor.uiBadgeBackground
        curationBadge.layer.cornerRadius = PBRadius.badge
        curationBadge.layer.cornerCurve = .continuous
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
        mediaBadge.backgroundColor = PBColor.uiBadgeBackground
        mediaBadge.layer.cornerRadius = PBRadius.badge
        mediaBadge.layer.cornerCurve = .continuous
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
        backupBadge.contentMode = .scaleAspectFit
        backupBadge.preferredSymbolConfiguration = UIImage.SymbolConfiguration(textStyle: .caption1)
            .applying(UIImage.SymbolConfiguration(weight: .semibold))
        backupBadge.layer.shadowColor = UIColor.black.cgColor
        backupBadge.layer.shadowOpacity = 0.6
        backupBadge.layer.shadowRadius = 2
        backupBadge.layer.shadowOffset = .zero
        backupBadge.isHidden = true
        backupBadge.translatesAutoresizingMaskIntoConstraints = false
        contentView.addSubview(backupBadge)
        NSLayoutConstraint.activate([
            backupBadge.leadingAnchor.constraint(equalTo: contentView.leadingAnchor, constant: 5),
            backupBadge.topAnchor.constraint(equalTo: contentView.topAnchor, constant: 5),
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
            rawBadge.widthAnchor.constraint(greaterThanOrEqualToConstant: 30),
            rawBadge.heightAnchor.constraint(greaterThanOrEqualToConstant: 16),
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
        displayedKey = nil
        imageView.image = nil
        imageView.alpha = 1
        checkmark.isHidden = true
        backupBadge.isHidden = true
        rawBadge.isHidden = true
        curationBadge.isHidden = true
        mediaBadge.isHidden = true
    }

    /// Image source currently displayed: the thumbnail URL or `asset:<id>`.
    private func imageKey(for item: LibraryEntry) -> String {
        if let local = item.local { return "asset:\(local.id)" }
        return item.remote?.thumbnailURL.absoluteString ?? ""
    }

    func configure(item: LibraryEntry, selected: Bool, loader: RedirectAwareImageLoader) {
        let key = imageKey(for: item)
        let keepsImage = representedID == item.id && displayedKey == key
        representedID = item.id
        imageView.alpha = item.isRejected ? Self.rejectedAlpha : 1
        checkmark.isHidden = !selected
        let badge = item.formatBadge
        rawBadge.text = badge
        rawBadge.isHidden = badge == nil
        configureCurationBadge(rating: item.rating, flag: item.flag)
        configureMediaBadge(item.mediaBadge)
        configureBackupBadge(item.backupState)
        var label = item.accessibilityName + CurationBadgeText.accessibilitySuffix(rating: item.rating, flag: item.flag)
        if let state = item.backupState { label += ", \(state.accessibilityText)" }
        accessibilityLabel = label
        accessibilityTraits = selected ? [.button, .selected] : [.button]

        guard !keepsImage else { return }
        loadTask?.cancel()
        displayedKey = nil
        imageView.image = nil
        let itemID = item.id
        if let local = item.local {
            // The device copy loads instantly and offline, even once the server has it.
            loadTask = Task { @MainActor [weak self] in
                let target = self?.bounds.size ?? CGSize(width: 160, height: 160)
                let image = try? await LocalImageLoader.shared.image(
                    assetID: local.id,
                    targetSize: target,
                    highQuality: false,
                    networkAllowed: false
                ) { degraded in
                    guard self?.representedID == itemID, self?.displayedKey == nil else { return }
                    self?.imageView.image = degraded
                }
                guard !Task.isCancelled, self?.representedID == itemID else { return }
                if let image {
                    self?.imageView.image = image
                    self?.displayedKey = key
                } else if let remote = item.remote {
                    self?.loadRemote(remote, itemID: itemID, key: key, loader: loader)
                }
            }
            return
        }
        guard let photo = item.remote, photo.thumbnailURL.host != "photos.example.invalid" else { return }
        loadRemote(photo, itemID: itemID, key: key, loader: loader)
    }

    /// `key` is the cell's image key: a synced cell whose device copy is unavailable keeps its
    /// asset key, so reconfigures keep this server image instead of reloading.
    private func loadRemote(_ photo: PhotoRecord, itemID: LibraryEntryID, key: String, loader: RedirectAwareImageLoader) {
        loadTask = Task { @MainActor [weak self] in
            let target = self?.bounds.size ?? CGSize(width: 160, height: 160)
            guard let image = try? await loader.image(
                for: photo,
                url: photo.thumbnailURL,
                targetSize: target
            ),
                  !Task.isCancelled,
                  self?.representedID == itemID else { return }
            self?.imageView.image = image
            self?.displayedKey = key
        }
    }

    private func configureBackupBadge(_ state: LocalBackupState?) {
        guard let state else {
            backupBadge.isHidden = true
            return
        }
        backupBadge.image = UIImage(systemName: state.systemImage)
        backupBadge.tintColor = state == .failed ? .systemYellow : .white
        backupBadge.isHidden = false
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

/// A black-to-clear gradient behind the status bar and toolbar while photos scroll under them.
@MainActor
private final class GradientScrimView: UIView {
    override class var layerClass: AnyClass { CAGradientLayer.self }

    override init(frame: CGRect) {
        super.init(frame: frame)
        let gradient = layer as! CAGradientLayer
        gradient.colors = [
            UIColor.black.withAlphaComponent(0.55).cgColor,
            UIColor.black.withAlphaComponent(0.25).cgColor,
            UIColor.clear.cgColor,
        ]
        gradient.locations = [0, 0.55, 1]
    }

    required init?(coder: NSCoder) {
        fatalError("init(coder:) has not been implemented")
    }
}

/// Neutral placeholder shown until a thumbnail loads, like Photos' grey tiles.
enum SyntheticThumbnail {
    static func color(id: Int) -> UIColor {
        .secondarySystemFill
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
