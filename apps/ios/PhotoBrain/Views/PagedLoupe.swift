import SwiftUI
import UIKit

struct PagedLoupe: UIViewControllerRepresentable {
    let records: [PhotoRecord]
    @Binding var activeID: Int
    let onTap: () -> Void
    let onEmpty: () -> Void

    func makeUIViewController(context: Context) -> PagedLoupeViewController {
        let controller = PagedLoupeViewController()
        controller.onActiveIDChanged = { activeID = $0 }
        controller.onEmpty = onEmpty
        controller.onTap = onTap
        controller.update(records: records, activeID: activeID)
        return controller
    }

    func updateUIViewController(_ controller: PagedLoupeViewController, context: Context) {
        controller.onActiveIDChanged = { activeID = $0 }
        controller.onEmpty = onEmpty
        controller.onTap = onTap
        controller.update(records: records, activeID: activeID)
    }
}

@MainActor
final class PagedLoupeViewController: UIViewController, UICollectionViewDataSource, UICollectionViewDelegate {
    private let layout = UICollectionViewFlowLayout()
    private lazy var collectionView = UICollectionView(frame: .zero, collectionViewLayout: layout)
    private let loader = RedirectAwareImageLoader()
    private let knownCells = NSHashTable<ZoomPageCell>.weakObjects()
    private var records: [PhotoRecord] = []
    private var activeID: Int?
    var onActiveIDChanged: ((Int) -> Void)?
    var onTap: (() -> Void)?
    var onEmpty: (() -> Void)?
    private var lastLayoutSize = CGSize.zero

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .black
        layout.scrollDirection = .horizontal
        layout.minimumLineSpacing = 0
        layout.minimumInteritemSpacing = 0
        collectionView.backgroundColor = .black
        collectionView.isPagingEnabled = true
        collectionView.showsHorizontalScrollIndicator = false
        collectionView.dataSource = self
        collectionView.delegate = self
        collectionView.register(ZoomPageCell.self, forCellWithReuseIdentifier: ZoomPageCell.reuseIdentifier)
        collectionView.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(collectionView)
        NSLayoutConstraint.activate([
            collectionView.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            collectionView.trailingAnchor.constraint(equalTo: view.trailingAnchor),
            collectionView.topAnchor.constraint(equalTo: view.topAnchor),
            collectionView.bottomAnchor.constraint(equalTo: view.bottomAnchor),
        ])
        NotificationCenter.default.addObserver(
            self,
            selector: #selector(handleMemoryWarning),
            name: UIApplication.didReceiveMemoryWarningNotification,
            object: nil
        )
    }

    deinit {
        NotificationCenter.default.removeObserver(self)
    }

    override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews()
        guard layout.itemSize != collectionView.bounds.size else { return }
        let changedOrientation = lastLayoutSize != .zero
            && (lastLayoutSize.width > lastLayoutSize.height) != (collectionView.bounds.width > collectionView.bounds.height)
        lastLayoutSize = collectionView.bounds.size
        layout.itemSize = collectionView.bounds.size
        layout.invalidateLayout()
        if changedOrientation {
            knownCells.allObjects.forEach { $0.zoomView.resetZoom() }
            collectionView.isScrollEnabled = true
        }
        scrollToActiveID(animated: false)
    }

    func update(records nextRecords: [PhotoRecord], activeID requestedID: Int) {
        loadViewIfNeeded()
        let previousIDs = records.map(\.id)
        let nextIDs = nextRecords.map(\.id)
        let anchoredID = PhotoIDAnchor.resolve(
            previousID: requestedID,
            previousOrderedIDs: previousIDs,
            nextOrderedIDs: nextIDs
        )
        let recordsChanged = previousIDs != nextIDs
        let refreshedIndexes = recordsChanged ? [] : records.indices.filter {
            records[$0].largeThumbnailURL != nextRecords[$0].largeThumbnailURL
                || records[$0].thumbnailURL != nextRecords[$0].thumbnailURL
        }
        records = nextRecords
        activeID = anchoredID
        if recordsChanged {
            collectionView.reloadData()
        } else if !refreshedIndexes.isEmpty {
            collectionView.reloadItems(at: refreshedIndexes.map { IndexPath(item: $0, section: 0) })
        }
        if let anchoredID, anchoredID != requestedID {
            onActiveIDChanged?(anchoredID)
        } else if anchoredID == nil {
            onEmpty?()
            return
        }
        scrollToActiveID(animated: !recordsChanged && refreshedIndexes.isEmpty)
    }

    func collectionView(_ collectionView: UICollectionView, numberOfItemsInSection section: Int) -> Int {
        records.count
    }

    func collectionView(
        _ collectionView: UICollectionView,
        cellForItemAt indexPath: IndexPath
    ) -> UICollectionViewCell {
        guard let cell = collectionView.dequeueReusableCell(
            withReuseIdentifier: ZoomPageCell.reuseIdentifier,
            for: indexPath
        ) as? ZoomPageCell else {
            return UICollectionViewCell()
        }
        guard records.indices.contains(indexPath.item) else {
            return UICollectionViewCell()
        }
        let photo = records[indexPath.item]
        cell.configure(
            photo: photo,
            loader: loader,
            onTap: { [weak self] in self?.onTap?() },
            onZoomChanged: { [weak self] _ in self?.updatePagingAvailability() }
        )
        knownCells.add(cell)
        return cell
    }

    func collectionView(
        _ collectionView: UICollectionView,
        willDisplay cell: UICollectionViewCell,
        forItemAt indexPath: IndexPath
    ) {
        (cell as? ZoomPageCell)?.reloadDecodedImageIfNeeded()
    }

    func scrollViewDidScroll(_ scrollView: UIScrollView) {
        reloadVisibleDecodedImagesIfNeeded()
    }

    func scrollViewDidEndDecelerating(_ scrollView: UIScrollView) {
        publishVisibleID()
    }

    func scrollViewDidEndScrollingAnimation(_ scrollView: UIScrollView) {
        publishVisibleID()
    }

    func collectionView(
        _ collectionView: UICollectionView,
        didEndDisplaying cell: UICollectionViewCell,
        forItemAt indexPath: IndexPath
    ) {
        updatePagingAvailability()
    }

    @objc private func handleMemoryWarning() {
        loader.removeAllCachedImages()
        let visibleCells = Set(collectionView.visibleCells.map(ObjectIdentifier.init))
        for cell in knownCells.allObjects {
            cell.handleMemoryWarning(
                isVisible: visibleCells.contains(ObjectIdentifier(cell)),
                activeID: activeID
            )
        }
    }

    private func reloadVisibleDecodedImagesIfNeeded() {
        collectionView.visibleCells
            .compactMap { $0 as? ZoomPageCell }
            .forEach { $0.reloadDecodedImageIfNeeded() }
    }

    private func scrollToActiveID(animated: Bool) {
        guard collectionView.bounds.width > 0,
              let activeID,
              let index = records.firstIndex(where: { $0.id == activeID }) else { return }
        let target = IndexPath(item: index, section: 0)
        guard collectionView.indexPathsForVisibleItems.contains(target) == false else { return }
        collectionView.scrollToItem(at: target, at: .centeredHorizontally, animated: animated)
    }

    private func publishVisibleID() {
        guard collectionView.bounds.width > 0 else { return }
        let index = Int(round(collectionView.contentOffset.x / collectionView.bounds.width))
        guard records.indices.contains(index) else { return }
        let id = records[index].id
        activeID = id
        onActiveIDChanged?(id)
    }

    private func updatePagingAvailability() {
        let zoomed = collectionView.visibleCells
            .compactMap { $0 as? ZoomPageCell }
            .contains { $0.zoomView.zoomScale > 1.001 }
        collectionView.isScrollEnabled = !zoomed
    }
}

@MainActor
final class ZoomPageCell: UICollectionViewCell {
    static let reuseIdentifier = "ZoomPageCell"

    let zoomView = ZoomingImageScrollView()
    private let failureStack = UIStackView()
    private let failureLabel = UILabel()
    private let retryButton = UIButton(type: .system)
    private var loadTask: Task<Void, Never>?
    private var retry: (() -> Void)?
    private(set) var representedID: Int?
    private var decodedImageWasEvicted = false

    override init(frame: CGRect) {
        super.init(frame: frame)
        zoomView.translatesAutoresizingMaskIntoConstraints = false
        failureStack.axis = .vertical
        failureStack.alignment = .center
        failureStack.spacing = 10
        failureStack.translatesAutoresizingMaskIntoConstraints = false
        failureLabel.text = "Unable to load photo"
        failureLabel.textColor = .white
        failureLabel.font = .preferredFont(forTextStyle: .body)
        retryButton.setTitle("Try Again", for: .normal)
        retryButton.accessibilityLabel = "Retry photo"
        retryButton.addTarget(self, action: #selector(retryLoad), for: .touchUpInside)
        failureStack.addArrangedSubview(failureLabel)
        failureStack.addArrangedSubview(retryButton)
        failureStack.isHidden = true
        contentView.addSubview(zoomView)
        contentView.addSubview(failureStack)
        NSLayoutConstraint.activate([
            zoomView.leadingAnchor.constraint(equalTo: contentView.leadingAnchor),
            zoomView.trailingAnchor.constraint(equalTo: contentView.trailingAnchor),
            zoomView.topAnchor.constraint(equalTo: contentView.topAnchor),
            zoomView.bottomAnchor.constraint(equalTo: contentView.bottomAnchor),
            failureStack.centerXAnchor.constraint(equalTo: contentView.centerXAnchor),
            failureStack.centerYAnchor.constraint(equalTo: contentView.centerYAnchor),
        ])
    }

    required init?(coder: NSCoder) {
        fatalError("init(coder:) has not been implemented")
    }

    override func prepareForReuse() {
        super.prepareForReuse()
        loadTask?.cancel()
        loadTask = nil
        retry = nil
        representedID = nil
        decodedImageWasEvicted = false
        failureStack.isHidden = true
        zoomView.setImage(nil)
        zoomView.onSingleTap = nil
        zoomView.onZoomStateChanged = nil
    }

    func configure(
        photo: PhotoRecord,
        loader: RedirectAwareImageLoader,
        onTap: @escaping () -> Void,
        onZoomChanged: @escaping (Bool) -> Void
    ) {
        loadTask?.cancel()
        retry = nil
        representedID = photo.id
        decodedImageWasEvicted = false
        failureStack.isHidden = true
        zoomView.onSingleTap = onTap
        zoomView.onZoomStateChanged = onZoomChanged
        zoomView.setImage(SyntheticThumbnail.image(id: photo.id, size: bounds.size))

        guard photo.largeThumbnailURL.host != "photos.example.invalid" else { return }
        let targetSize = bounds.size == .zero ? UIScreen.main.bounds.size : bounds.size
        let load = { [weak self] in
            guard let self else { return }
            self.failureStack.isHidden = true
            self.loadTask?.cancel()
            self.loadTask = Task { @MainActor [weak self] in
                if let small = try? await loader.image(
                    for: photo,
                    url: photo.thumbnailURL,
                    targetSize: targetSize
                ), !Task.isCancelled, self?.representedID == photo.id {
                    self?.zoomView.setImage(small, resetsZoom: false)
                }
                guard !Task.isCancelled else { return }
                do {
                    let image = try await loader.image(
                        for: photo,
                        url: photo.largeThumbnailURL,
                        targetSize: targetSize
                    )
                    guard !Task.isCancelled, self?.representedID == photo.id else { return }
                    self?.zoomView.setImage(image, resetsZoom: false)
                } catch is CancellationError {
                    return
                } catch {
                    guard self?.representedID == photo.id else { return }
                    self?.failureStack.isHidden = false
                }
            }
        }
        retry = load
        load()
    }

    func handleMemoryWarning(isVisible: Bool, activeID: Int?) {
        guard !isVisible, representedID != activeID else { return }
        evictDecodedImage()
    }

    func reloadDecodedImageIfNeeded() {
        guard decodedImageWasEvicted, let representedID else { return }
        decodedImageWasEvicted = false
        zoomView.setImage(
            SyntheticThumbnail.image(id: representedID, size: bounds.size),
            resetsZoom: false
        )
        retry?()
    }

    private func evictDecodedImage() {
        loadTask?.cancel()
        loadTask = nil
        decodedImageWasEvicted = true
        zoomView.setImage(nil, resetsZoom: false)
    }

    @objc private func retryLoad() {
        retry?()
    }
}

@MainActor
final class ZoomingImageScrollView: UIScrollView, UIScrollViewDelegate {
    private let imageView = UIImageView()
    var onSingleTap: (() -> Void)?
    var onZoomStateChanged: ((Bool) -> Void)?

    override init(frame: CGRect) {
        super.init(frame: frame)
        delegate = self
        minimumZoomScale = 1
        maximumZoomScale = 5
        bouncesZoom = true
        showsHorizontalScrollIndicator = false
        showsVerticalScrollIndicator = false
        backgroundColor = .black

        imageView.contentMode = .scaleAspectFit
        imageView.translatesAutoresizingMaskIntoConstraints = false
        addSubview(imageView)
        NSLayoutConstraint.activate([
            imageView.leadingAnchor.constraint(equalTo: contentLayoutGuide.leadingAnchor),
            imageView.trailingAnchor.constraint(equalTo: contentLayoutGuide.trailingAnchor),
            imageView.topAnchor.constraint(equalTo: contentLayoutGuide.topAnchor),
            imageView.bottomAnchor.constraint(equalTo: contentLayoutGuide.bottomAnchor),
            imageView.widthAnchor.constraint(equalTo: frameLayoutGuide.widthAnchor),
            imageView.heightAnchor.constraint(equalTo: frameLayoutGuide.heightAnchor),
        ])

        let doubleTap = UITapGestureRecognizer(target: self, action: #selector(handleDoubleTap(_:)))
        doubleTap.numberOfTapsRequired = 2
        let singleTap = UITapGestureRecognizer(target: self, action: #selector(handleSingleTap))
        singleTap.require(toFail: doubleTap)
        addGestureRecognizer(doubleTap)
        addGestureRecognizer(singleTap)
    }

    required init?(coder: NSCoder) {
        fatalError("init(coder:) has not been implemented")
    }

    func setImage(_ image: UIImage?, resetsZoom: Bool = true) {
        if resetsZoom { resetZoom() }
        imageView.image = image
    }

    var hasImage: Bool {
        imageView.image != nil
    }

    func resetZoom() {
        setZoomScale(minimumZoomScale, animated: false)
        onZoomStateChanged?(false)
    }

    func viewForZooming(in scrollView: UIScrollView) -> UIView? {
        imageView
    }

    func scrollViewDidZoom(_ scrollView: UIScrollView) {
        onZoomStateChanged?(zoomScale > minimumZoomScale + 0.001)
    }

    @objc private func handleSingleTap() {
        onSingleTap?()
    }

    @objc private func handleDoubleTap(_ recognizer: UITapGestureRecognizer) {
        let targetScale = zoomScale > minimumZoomScale ? minimumZoomScale : min(3, maximumZoomScale)
        setZoomScale(targetScale, animated: true)
    }
}
