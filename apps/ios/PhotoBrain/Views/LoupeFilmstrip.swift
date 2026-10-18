import SwiftUI
import UIKit

/// Photos-style loupe filmstrip: narrow thumbnails with the centered one widened. Dragging
/// scrubs (the photo under the center becomes the open photo as it passes), scrolling settles
/// on a thumbnail, and tapping jumps to one. A UIKit collection view so only visible frames are
/// laid out, whatever the library size.
struct LoupeFilmstrip: UIViewRepresentable {
    let records: [LibraryEntry]
    let activeID: LibraryEntryID
    let height: CGFloat
    let reduceMotion: Bool
    /// The user scrubbed or tapped to `id`; the pager should jump there without animating.
    let onSelect: (LibraryEntryID) -> Void

    func makeUIView(context: Context) -> FilmstripView {
        let view = FilmstripView()
        view.onSelect = onSelect
        view.update(records: records, activeID: activeID, height: height, reduceMotion: reduceMotion)
        return view
    }

    func updateUIView(_ view: FilmstripView, context: Context) {
        view.onSelect = onSelect
        view.update(records: records, activeID: activeID, height: height, reduceMotion: reduceMotion)
    }

    func sizeThatFits(_ proposal: ProposedViewSize, uiView: FilmstripView, context: Context) -> CGSize? {
        CGSize(width: proposal.width ?? UIScreen.main.bounds.width, height: height + 4)
    }
}

/// Geometry of the filmstrip. Items sit `unit` apart; the item at fractional index
/// `c = contentOffset.x / unit` is centered, and the two items around `c` share the extra
/// width in proportion to their distance from it, so widening is continuous while scrolling.
struct FilmstripGeometry: Equatable {
    var itemHeight: CGFloat
    var spacing: CGFloat = 2
    /// Inset on each side of the widened item.
    var activeMargin: CGFloat = 4
    var viewWidth: CGFloat
    var count: Int

    var narrowWidth: CGFloat { (itemHeight * 0.62).rounded() }
    var wideWidth: CGFloat { (itemHeight * 1.4).rounded() }
    var unit: CGFloat { narrowWidth + spacing }
    /// Extra extent the centered item takes, including its margins.
    var extra: CGFloat { wideWidth - narrowWidth + 2 * activeMargin }
    var leadingPad: CGFloat { max(0, viewWidth / 2 - (narrowWidth + extra) / 2) }

    var contentSize: CGSize {
        guard count > 0 else { return CGSize(width: viewWidth, height: itemHeight) }
        return CGSize(width: max(viewWidth, viewWidth + CGFloat(count - 1) * unit), height: itemHeight)
    }

    func offset(forIndex index: Int) -> CGFloat {
        CGFloat(index) * unit
    }

    func nearestIndex(forOffset offset: CGFloat) -> Int {
        guard count > 0 else { return 0 }
        return min(count - 1, max(0, Int((offset / unit).rounded())))
    }

    /// Frame of `index` when the strip is scrolled to `offset`.
    func frame(forIndex index: Int, offset: CGFloat) -> CGRect {
        let center = min(CGFloat(max(0, count - 1)), max(0, offset / unit))
        let lower = Int(center.rounded(.down))
        let t = center - CGFloat(lower)
        let weight: CGFloat
        let before: CGFloat
        if index == lower {
            weight = 1 - t
            before = 0
        } else if index == lower + 1 {
            weight = t
            before = 1 - t
        } else {
            weight = 0
            before = index > lower ? 1 : 0
        }
        let x = leadingPad + CGFloat(index) * unit + extra * before + activeMargin * weight
        return CGRect(x: x, y: 0, width: narrowWidth + (wideWidth - narrowWidth) * weight, height: itemHeight)
    }

    /// Indexes whose frames can intersect the horizontal range `minX...maxX`.
    func indexes(in minX: CGFloat, _ maxX: CGFloat) -> ClosedRange<Int>? {
        guard count > 0 else { return nil }
        let low = Int(((minX - leadingPad - extra - narrowWidth) / unit).rounded(.down))
        let high = Int(((maxX - leadingPad) / unit).rounded(.up))
        let lower = max(0, low)
        let upper = min(count - 1, high)
        return lower <= upper ? lower...upper : nil
    }
}

final class FilmstripLayout: UICollectionViewLayout {
    var itemHeight: CGFloat = 40 {
        didSet { if itemHeight != oldValue { invalidateLayout() } }
    }

    var geometry: FilmstripGeometry {
        FilmstripGeometry(
            itemHeight: itemHeight,
            viewWidth: collectionView?.bounds.width ?? 0,
            count: collectionView?.numberOfItems(inSection: 0) ?? 0
        )
    }

    override var collectionViewContentSize: CGSize {
        geometry.contentSize
    }

    override func layoutAttributesForElements(in rect: CGRect) -> [UICollectionViewLayoutAttributes]? {
        let geometry = geometry
        guard let range = geometry.indexes(in: rect.minX, rect.maxX) else { return [] }
        let offset = collectionView?.contentOffset.x ?? 0
        return range.map { attributes(for: $0, geometry: geometry, offset: offset) }
    }

    override func layoutAttributesForItem(at indexPath: IndexPath) -> UICollectionViewLayoutAttributes? {
        let geometry = geometry
        guard indexPath.item < geometry.count else { return nil }
        return attributes(for: indexPath.item, geometry: geometry, offset: collectionView?.contentOffset.x ?? 0)
    }

    private func attributes(
        for index: Int,
        geometry: FilmstripGeometry,
        offset: CGFloat
    ) -> UICollectionViewLayoutAttributes {
        let attributes = UICollectionViewLayoutAttributes(forCellWith: IndexPath(item: index, section: 0))
        attributes.frame = geometry.frame(forIndex: index, offset: offset)
        return attributes
    }

    /// Widths follow the scroll position, so every scroll frame relayouts (visible items only).
    override func shouldInvalidateLayout(forBoundsChange newBounds: CGRect) -> Bool {
        true
    }

    /// Scrolling always settles with a thumbnail centered.
    override func targetContentOffset(
        forProposedContentOffset proposedContentOffset: CGPoint,
        withScrollingVelocity velocity: CGPoint
    ) -> CGPoint {
        let geometry = geometry
        return CGPoint(x: geometry.offset(forIndex: geometry.nearestIndex(forOffset: proposedContentOffset.x)), y: 0)
    }
}

@MainActor
final class FilmstripView: UIView, UICollectionViewDataSource, UICollectionViewDelegate,
    UICollectionViewDataSourcePrefetching {
    private let layout = FilmstripLayout()
    private(set) lazy var collectionView = UICollectionView(frame: .zero, collectionViewLayout: layout)
    private let loader = RedirectAwareImageLoader()
    private var records: [LibraryEntry] = []
    private var activeID: LibraryEntryID?
    private var reduceMotion = false
    /// True from the start of a drag until scrolling settles; scroll positions then drive the
    /// open photo instead of following it.
    private(set) var isScrubbing = false
    private var lastReportedID: LibraryEntryID?
    private var needsInitialCentering = true
    private var lastWidth: CGFloat = 0
    private var prefetchTasks: [LibraryEntryID: Task<Void, Never>] = [:]
    var onSelect: ((LibraryEntryID) -> Void)?

    override init(frame: CGRect) {
        super.init(frame: frame)
        collectionView.backgroundColor = .clear
        collectionView.showsHorizontalScrollIndicator = false
        collectionView.decelerationRate = .normal
        collectionView.dataSource = self
        collectionView.delegate = self
        collectionView.prefetchDataSource = self
        collectionView.contentInsetAdjustmentBehavior = .never
        collectionView.register(FilmstripCell.self, forCellWithReuseIdentifier: FilmstripCell.reuseIdentifier)
        collectionView.accessibilityIdentifier = "loupe-filmstrip"
        addSubview(collectionView)
    }

    required init?(coder: NSCoder) {
        fatalError("init(coder:) has not been implemented")
    }

    override func layoutSubviews() {
        super.layoutSubviews()
        let frame = CGRect(x: 0, y: 2, width: bounds.width, height: layout.itemHeight)
        if collectionView.frame != frame {
            collectionView.frame = frame
        }
        if bounds.width > 0, bounds.width != lastWidth || needsInitialCentering {
            lastWidth = bounds.width
            needsInitialCentering = false
            layout.invalidateLayout()
            collectionView.layoutIfNeeded()
            centerActive(animated: false)
        }
    }

    func update(records nextRecords: [LibraryEntry], activeID nextActiveID: LibraryEntryID, height: CGFloat, reduceMotion: Bool) {
        self.reduceMotion = reduceMotion
        layout.itemHeight = height
        let recordsChanged = !nextRecords.sharesStorage(with: records)
            && nextRecords.map(\.id) != records.map(\.id)
        let refreshed = !recordsChanged && !nextRecords.sharesStorage(with: records)
        let previousActiveID = activeID
        records = nextRecords
        activeID = nextActiveID
        if recordsChanged {
            collectionView.reloadData()
            if !isScrubbing {
                collectionView.layoutIfNeeded()
                centerActive(animated: false)
            }
            return
        }
        if refreshed {
            reconfigureVisibleCells()
        } else if previousActiveID != nextActiveID {
            updateVisibleSelection()
        }
        // While scrubbing the strip leads; the open photo follows it.
        guard !isScrubbing, previousActiveID != nextActiveID else { return }
        centerActive(animated: !reduceMotion)
    }

    private func centerActive(animated: Bool) {
        guard bounds.width > 0, let activeID,
              let index = records.firstIndex(where: { $0.id == activeID }) else { return }
        lastReportedID = activeID
        let target = CGPoint(x: layout.geometry.offset(forIndex: index), y: 0)
        guard abs(collectionView.contentOffset.x - target.x) > 0.5 else { return }
        if animated {
            UIView.animate(withDuration: 0.22, delay: 0, options: [.curveEaseOut, .allowUserInteraction, .beginFromCurrentState]) {
                self.collectionView.setContentOffset(target, animated: false)
                self.collectionView.layoutIfNeeded()
            }
        } else {
            collectionView.setContentOffset(target, animated: false)
        }
    }

    // MARK: Scrubbing

    func scrollViewWillBeginDragging(_ scrollView: UIScrollView) {
        isScrubbing = true
    }

    func scrollViewDidScroll(_ scrollView: UIScrollView) {
        guard isScrubbing, !records.isEmpty else { return }
        let index = layout.geometry.nearestIndex(forOffset: scrollView.contentOffset.x)
        let id = records[index].id
        guard id != lastReportedID else { return }
        lastReportedID = id
        activeID = id
        updateVisibleSelection()
        onSelect?(id)
    }

    func scrollViewDidEndDragging(_ scrollView: UIScrollView, willDecelerate decelerate: Bool) {
        if !decelerate { endScrubbing() }
    }

    func scrollViewDidEndDecelerating(_ scrollView: UIScrollView) {
        endScrubbing()
    }

    private func endScrubbing() {
        guard isScrubbing else { return }
        isScrubbing = false
        // The settle position is always centered on a thumbnail; make sure it is the open one.
        if activeID != lastReportedID { centerActive(animated: !reduceMotion) }
    }

    func collectionView(_ collectionView: UICollectionView, didSelectItemAt indexPath: IndexPath) {
        guard records.indices.contains(indexPath.item) else { return }
        let id = records[indexPath.item].id
        guard id != activeID else { return }
        activeID = id
        updateVisibleSelection()
        centerActive(animated: !reduceMotion)
        onSelect?(id)
    }

    // MARK: Data source

    func collectionView(_ collectionView: UICollectionView, numberOfItemsInSection section: Int) -> Int {
        records.count
    }

    func collectionView(_ collectionView: UICollectionView, cellForItemAt indexPath: IndexPath) -> UICollectionViewCell {
        let cell = collectionView.dequeueReusableCell(
            withReuseIdentifier: FilmstripCell.reuseIdentifier,
            for: indexPath
        ) as! FilmstripCell
        if records.indices.contains(indexPath.item) {
            let photo = records[indexPath.item]
            cell.configure(item: photo, active: photo.id == activeID, loader: loader, targetSize: thumbnailSize)
        }
        return cell
    }

    func collectionView(_ collectionView: UICollectionView, prefetchItemsAt indexPaths: [IndexPath]) {
        let size = thumbnailSize
        for indexPath in indexPaths where records.indices.contains(indexPath.item) {
            let item = records[indexPath.item]
            // Device photos load from PhotoKit on demand; only server thumbnails prefetch.
            guard item.local == nil, let photo = item.remote, prefetchTasks[item.id] == nil,
                  photo.thumbnailURL.host != "photos.example.invalid" else { continue }
            prefetchTasks[item.id] = Task { [weak self, loader] in
                _ = try? await loader.image(for: photo, url: photo.thumbnailURL, targetSize: size)
                self?.prefetchTasks[item.id] = nil
            }
        }
    }

    func collectionView(_ collectionView: UICollectionView, cancelPrefetchingForItemsAt indexPaths: [IndexPath]) {
        for indexPath in indexPaths where records.indices.contains(indexPath.item) {
            prefetchTasks.removeValue(forKey: records[indexPath.item].id)?.cancel()
        }
    }

    /// Decoded at the widened size so a thumbnail stays sharp when it becomes the centered one.
    private var thumbnailSize: CGSize {
        let geometry = layout.geometry
        return CGSize(width: geometry.wideWidth, height: geometry.itemHeight)
    }

    private func updateVisibleSelection() {
        for case let cell as FilmstripCell in collectionView.visibleCells {
            cell.setActive(cell.representedID == activeID)
        }
    }

    private func reconfigureVisibleCells() {
        for indexPath in collectionView.indexPathsForVisibleItems {
            guard records.indices.contains(indexPath.item),
                  let cell = collectionView.cellForItem(at: indexPath) as? FilmstripCell else { continue }
            let photo = records[indexPath.item]
            cell.configure(item: photo, active: photo.id == activeID, loader: loader, targetSize: thumbnailSize)
        }
    }
}

@MainActor
final class FilmstripCell: UICollectionViewCell {
    static let reuseIdentifier = "FilmstripCell"

    private let imageView = UIImageView()
    private var loadTask: Task<Void, Never>?
    private var displayedKey: String?
    private(set) var representedID: LibraryEntryID?

    override init(frame: CGRect) {
        super.init(frame: frame)
        contentView.backgroundColor = UIColor(white: 0.2, alpha: 1)
        contentView.layer.cornerRadius = 3
        contentView.layer.cornerCurve = .continuous
        contentView.clipsToBounds = true
        contentView.layer.borderColor = UIColor.white.cgColor
        imageView.contentMode = .scaleAspectFill
        imageView.clipsToBounds = true
        imageView.frame = contentView.bounds
        imageView.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        contentView.addSubview(imageView)
        isAccessibilityElement = true
    }

    required init?(coder: NSCoder) {
        fatalError("init(coder:) has not been implemented")
    }

    override func prepareForReuse() {
        super.prepareForReuse()
        loadTask?.cancel()
        loadTask = nil
    }

    func configure(item: LibraryEntry, active: Bool, loader: RedirectAwareImageLoader, targetSize: CGSize) {
        let key = item.local.map { "asset:\($0.id)" } ?? item.remote?.thumbnailURL.absoluteString
        let keepsImage = representedID == item.id && displayedKey == key && imageView.image != nil
        representedID = item.id
        imageView.alpha = item.isRejected ? 0.35 : 1
        accessibilityLabel = "Open \(item.remote?.filename ?? item.accessibilityName)"
        setActive(active)
        guard !keepsImage else { return }
        loadTask?.cancel()
        imageView.image = nil
        displayedKey = nil
        let itemID = item.id
        if let local = item.local {
            loadTask = Task { @MainActor [weak self] in
                guard let image = try? await LocalImageLoader.shared.image(
                    assetID: local.id,
                    targetSize: targetSize,
                    highQuality: false,
                    networkAllowed: false
                ), !Task.isCancelled, let self, self.representedID == itemID else { return }
                self.imageView.image = image
                self.displayedKey = key
            }
            return
        }
        guard let photo = item.remote, photo.thumbnailURL.host != "photos.example.invalid" else { return }
        loadTask = Task { @MainActor [weak self] in
            guard let image = try? await loader.image(for: photo, url: photo.thumbnailURL, targetSize: targetSize),
                  !Task.isCancelled, let self, self.representedID == itemID else { return }
            self.imageView.image = image
            self.displayedKey = key
        }
    }

    func setActive(_ active: Bool) {
        contentView.layer.borderWidth = active ? 2 : 0
        accessibilityTraits = active ? [.button, .selected] : .button
    }
}

extension Array {
    /// True when both arrays use the same storage, i.e. one is an unmodified copy of the other.
    /// A cheap check that skips element-wise diffs when SwiftUI re-passes the same array.
    func sharesStorage(with other: [Element]) -> Bool {
        guard count == other.count else { return false }
        guard !isEmpty else { return true }
        return withUnsafeBufferPointer { lhs in
            other.withUnsafeBufferPointer { rhs in lhs.baseAddress == rhs.baseAddress }
        }
    }
}
