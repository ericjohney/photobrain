import AVKit
import Combine
import SwiftUI
import UIKit

struct PagedLoupe: UIViewControllerRepresentable {
    let records: [PhotoRecord]
    @Binding var activeID: Int
    /// Drives the open page's video or Live Photo player; the loupe owns its lifetime.
    let playback: LoupePlaybackController
    /// Insets the video controls so the loupe chrome does not cover them.
    let chromeVisible: Bool
    let onTap: () -> Void
    let onEmpty: () -> Void
    /// Face boxes drawn over each photo by id; empty when Show Faces is off.
    var faceBoxes: [Int: [FaceBoxDTO]] = [:]

    func makeUIViewController(context: Context) -> PagedLoupeViewController {
        let controller = PagedLoupeViewController()
        controller.onActiveIDChanged = { activeID = $0 }
        controller.onEmpty = onEmpty
        controller.onTap = onTap
        controller.attach(playback: playback)
        controller.chromeVisible = chromeVisible
        controller.faceBoxes = faceBoxes
        controller.update(records: records, activeID: activeID)
        return controller
    }

    func updateUIViewController(_ controller: PagedLoupeViewController, context: Context) {
        controller.onActiveIDChanged = { activeID = $0 }
        controller.onEmpty = onEmpty
        controller.onTap = onTap
        controller.attach(playback: playback)
        controller.chromeVisible = chromeVisible
        controller.faceBoxes = faceBoxes
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
    private var playback: LoupePlaybackController?
    private var playbackSubscription: AnyCancellable?
    /// The single on-screen player, hosted by the cell of the playing page.
    private var playerController: AVPlayerViewController?
    private var readyObservation: NSKeyValueObservation?
    private var playbackState: LoupePlaybackController.State = .inactive
    var chromeVisible = true {
        didSet {
            guard chromeVisible != oldValue else { return }
            applyChromeInsets()
        }
    }
    /// Face boxes by photo id, applied to every cell showing that photo.
    var faceBoxes: [Int: [FaceBoxDTO]] = [:] {
        didSet {
            guard faceBoxes != oldValue else { return }
            knownCells.allObjects.forEach { cell in
                cell.setFaceBoxes(cell.representedID.flatMap { faceBoxes[$0] } ?? [])
            }
        }
    }

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

    func attach(playback next: LoupePlaybackController) {
        guard playback !== next else { return }
        playback = next
        // `@Published` emits before the new value is stored; hopping to the next main-queue turn
        // lets `apply` read the controller's current state and player together.
        playbackSubscription = next.$state
            .receive(on: DispatchQueue.main)
            .sink { [weak self] _ in
                MainActor.assumeIsolated {
                    guard let self, let playback = self.playback else { return }
                    self.apply(playbackState: playback.state)
                }
            }
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
        cell.setFaceBoxes(faceBoxes[photo.id] ?? [])
        syncPlayerHost()
        return cell
    }

    func collectionView(
        _ collectionView: UICollectionView,
        willDisplay cell: UICollectionViewCell,
        forItemAt indexPath: IndexPath
    ) {
        (cell as? ZoomPageCell)?.reloadDecodedImageIfNeeded()
        syncPlayerHost()
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

    // MARK: Playback

    private func apply(playbackState state: LoupePlaybackController.State) {
        playbackState = state
        switch state {
        case .inactive, .still:
            detachPlayer()
        case let .video(_, ready), let .live(_, ready):
            guard let avPlayer = playback?.player?.avPlayer else {
                detachPlayer()
                return
            }
            let isVideo = if case .video = state { true } else { false }
            let host = playerController ?? makePlayerController()
            if host.player !== avPlayer {
                host.player = avPlayer
                observeReadiness(of: host, photoID: state.photoID)
            }
            host.showsPlaybackControls = isVideo
            // A motion clip is display-only: taps fall through to the still's zoom view.
            host.view.isUserInteractionEnabled = isVideo
            host.view.alpha = ready ? 1 : 0
            syncPlayerHost()
        }
    }

    private func makePlayerController() -> AVPlayerViewController {
        let host = AVPlayerViewController()
        host.allowsPictureInPicturePlayback = false
        host.updatesNowPlayingInfoCenter = false
        host.view.backgroundColor = .clear
        host.view.translatesAutoresizingMaskIntoConstraints = false
        addChild(host)
        host.didMove(toParent: self)
        playerController = host
        applyChromeInsets()
        return host
    }

    /// Until the first frame is ready the page keeps showing its large thumbnail.
    private func observeReadiness(of host: AVPlayerViewController, photoID: Int?) {
        readyObservation?.invalidate()
        guard let photoID else { return }
        readyObservation = host.observe(\.isReadyForDisplay, options: [.initial, .new]) { [weak self] host, _ in
            let ready = host.isReadyForDisplay
            DispatchQueue.main.async {
                guard ready else { return }
                MainActor.assumeIsolated { self?.playback?.playerReadyForDisplay(photoID: photoID) }
            }
        }
    }

    /// Moves the player view into the cell showing the playing page, or out of every cell when
    /// no page plays or that page is not on screen.
    private func syncPlayerHost() {
        guard let playerController else { return }
        let target = playbackState.photoID.flatMap { id in
            knownCells.allObjects.first { $0.representedID == id }
        }
        guard let target else {
            playerController.view.removeFromSuperview()
            return
        }
        target.host(playerView: playerController.view)
    }

    private func detachPlayer() {
        readyObservation?.invalidate()
        readyObservation = nil
        guard let playerController else { return }
        playerController.player = nil
        playerController.willMove(toParent: nil)
        playerController.view.removeFromSuperview()
        playerController.removeFromParent()
        self.playerController = nil
    }

    private func applyChromeInsets() {
        playerController?.additionalSafeAreaInsets = chromeVisible
            ? UIEdgeInsets(top: 52, left: 0, bottom: 140, right: 0)
            : .zero
    }
}

@MainActor
final class ZoomPageCell: UICollectionViewCell {
    static let reuseIdentifier = "ZoomPageCell"

    let zoomView = ZoomingImageScrollView()
    /// Face boxes over the image; follows the zoom view's pinch-zoom and pan.
    private let faceOverlay = FaceBoxOverlayView()
    private var faceBoxes: [FaceBoxDTO] = []
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
        faceOverlay.translatesAutoresizingMaskIntoConstraints = false
        contentView.addSubview(zoomView)
        contentView.addSubview(faceOverlay)
        contentView.addSubview(failureStack)
        zoomView.onGeometryChanged = { [weak self] in self?.layoutFaceBoxes() }
        NSLayoutConstraint.activate([
            zoomView.leadingAnchor.constraint(equalTo: contentView.leadingAnchor),
            zoomView.trailingAnchor.constraint(equalTo: contentView.trailingAnchor),
            zoomView.topAnchor.constraint(equalTo: contentView.topAnchor),
            zoomView.bottomAnchor.constraint(equalTo: contentView.bottomAnchor),
            faceOverlay.leadingAnchor.constraint(equalTo: contentView.leadingAnchor),
            faceOverlay.trailingAnchor.constraint(equalTo: contentView.trailingAnchor),
            faceOverlay.topAnchor.constraint(equalTo: contentView.topAnchor),
            faceOverlay.bottomAnchor.constraint(equalTo: contentView.bottomAnchor),
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
        setFaceBoxes([])
        hostedPlayerView?.removeFromSuperview()
    }

    private weak var hostedPlayerView: UIView?

    /// Shows the loupe's player above this page's image, filling the cell.
    func host(playerView: UIView) {
        guard playerView.superview !== contentView else { return }
        playerView.removeFromSuperview()
        contentView.insertSubview(playerView, belowSubview: failureStack)
        NSLayoutConstraint.activate([
            playerView.leadingAnchor.constraint(equalTo: contentView.leadingAnchor),
            playerView.trailingAnchor.constraint(equalTo: contentView.trailingAnchor),
            playerView.topAnchor.constraint(equalTo: contentView.topAnchor),
            playerView.bottomAnchor.constraint(equalTo: contentView.bottomAnchor),
        ])
        hostedPlayerView = playerView
    }

    /// Draws `boxes` (normalized to the oriented image) over the photo; empty hides them.
    func setFaceBoxes(_ boxes: [FaceBoxDTO]) {
        guard boxes != faceBoxes else { return }
        faceBoxes = boxes
        layoutFaceBoxes()
    }

    override func layoutSubviews() {
        super.layoutSubviews()
        layoutFaceBoxes()
    }

    /// Boxes are drawn only over a loaded thumbnail: the synthetic placeholder has the cell's
    /// aspect ratio, not the photo's, so boxes over it would be misplaced.
    private var showsPhotoImage = false

    private func layoutFaceBoxes() {
        guard showsPhotoImage, !faceBoxes.isEmpty, let geometry = zoomView.faceGeometry else {
            faceOverlay.show([])
            return
        }
        faceOverlay.show(faceBoxes.map { box in
            FaceGeometry.rect(
                for: box,
                imageSize: geometry.imageSize,
                in: geometry.viewSize,
                zoomScale: geometry.zoomScale,
                contentOffset: geometry.contentOffset
            )
        })
    }

    func configure(
        photo: PhotoRecord,
        loader: RedirectAwareImageLoader,
        onTap: @escaping () -> Void,
        onZoomChanged: @escaping (Bool) -> Void
    ) {
        loadTask?.cancel()
        retry = nil
        if representedID != photo.id {
            hostedPlayerView?.removeFromSuperview()
        }
        representedID = photo.id
        decodedImageWasEvicted = false
        failureStack.isHidden = true
        zoomView.onSingleTap = onTap
        zoomView.onZoomStateChanged = onZoomChanged
        zoomView.setImage(SyntheticThumbnail.image(id: photo.id, size: bounds.size))
        setShowsPhotoImage(false)

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
                    self?.setShowsPhotoImage(true)
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
                    self?.setShowsPhotoImage(true)
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
        setShowsPhotoImage(false)
        retry?()
    }

    private func evictDecodedImage() {
        loadTask?.cancel()
        loadTask = nil
        decodedImageWasEvicted = true
        zoomView.setImage(nil, resetsZoom: false)
        setShowsPhotoImage(false)
    }

    private func setShowsPhotoImage(_ value: Bool) {
        showsPhotoImage = value
        layoutFaceBoxes()
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
    /// Called whenever the image, zoom, pan, or size changes, so overlays can follow.
    var onGeometryChanged: (() -> Void)?

    /// What an overlay needs to place normalized image points on screen.
    struct FaceOverlayGeometry {
        let imageSize: CGSize
        /// The unzoomed image view size (the scroll view's frame).
        let viewSize: CGSize
        let zoomScale: CGFloat
        /// Content offset relative to the zoomed image view's origin.
        let contentOffset: CGPoint
    }

    /// `nil` until an image is shown and the view has a size.
    var faceGeometry: FaceOverlayGeometry? {
        guard let image = imageView.image, bounds.width > 0, bounds.height > 0 else { return nil }
        return FaceOverlayGeometry(
            imageSize: image.size,
            viewSize: frame.size,
            zoomScale: zoomScale,
            contentOffset: CGPoint(
                x: contentOffset.x - imageView.frame.minX,
                y: contentOffset.y - imageView.frame.minY
            )
        )
    }

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
        onGeometryChanged?()
    }

    override func layoutSubviews() {
        super.layoutSubviews()
        onGeometryChanged?()
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
        onGeometryChanged?()
    }

    func scrollViewDidScroll(_ scrollView: UIScrollView) {
        onGeometryChanged?()
    }

    @objc private func handleSingleTap() {
        onSingleTap?()
    }

    @objc private func handleDoubleTap(_ recognizer: UITapGestureRecognizer) {
        let targetScale = zoomScale > minimumZoomScale ? minimumZoomScale : min(3, maximumZoomScale)
        setZoomScale(targetScale, animated: true)
    }
}

/// Outlines face rects over a loupe page. Purely visual: it never intercepts touches, so
/// pinch, pan, paging, and taps reach the zoom view underneath.
@MainActor
final class FaceBoxOverlayView: UIView {
    private var boxLayers: [CAShapeLayer] = []

    override init(frame: CGRect) {
        super.init(frame: frame)
        isUserInteractionEnabled = false
        clipsToBounds = true
        isAccessibilityElement = false
    }

    required init?(coder: NSCoder) {
        fatalError("init(coder:) has not been implemented")
    }

    /// Replaces the outlines with `rects` (in this view's coordinates) without animation.
    func show(_ rects: [CGRect]) {
        let visible = rects.filter { !$0.isNull && !$0.isEmpty }
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        while boxLayers.count < visible.count {
            let shape = CAShapeLayer()
            shape.fillColor = UIColor.clear.cgColor
            shape.strokeColor = UIColor.white.withAlphaComponent(0.9).cgColor
            shape.lineWidth = 2
            shape.shadowColor = UIColor.black.cgColor
            shape.shadowOpacity = 0.6
            shape.shadowRadius = 2
            shape.shadowOffset = .zero
            layer.addSublayer(shape)
            boxLayers.append(shape)
        }
        for (index, shape) in boxLayers.enumerated() {
            if index < visible.count {
                shape.isHidden = false
                shape.path = UIBezierPath(roundedRect: visible[index], cornerRadius: 6).cgPath
            } else {
                shape.isHidden = true
            }
        }
        CATransaction.commit()
    }
}
