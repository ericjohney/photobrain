import CoreGraphics

/// Maps normalized face boxes (0...1 of the oriented image, origin top-left) onto the loupe's
/// aspect-fit image, including the scroll view's pinch-zoom and pan.
enum FaceGeometry {
    /// The rect an image of `imageSize` occupies when aspect-fit and centered in a view of
    /// `viewSize`: letterboxed above and below for wide images, pillarboxed for tall ones.
    static func aspectFitRect(imageSize: CGSize, in viewSize: CGSize) -> CGRect {
        guard imageSize.width > 0, imageSize.height > 0, viewSize.width > 0, viewSize.height > 0 else {
            return .zero
        }
        let scale = min(viewSize.width / imageSize.width, viewSize.height / imageSize.height)
        let size = CGSize(width: imageSize.width * scale, height: imageSize.height * scale)
        return CGRect(
            x: (viewSize.width - size.width) / 2,
            y: (viewSize.height - size.height) / 2,
            width: size.width,
            height: size.height
        )
    }

    /// The face's rect in the image view's own (unzoomed) coordinates, clamped to the image.
    static func rect(for box: FaceBoxDTO, imageSize: CGSize, in viewSize: CGSize) -> CGRect {
        let image = aspectFitRect(imageSize: imageSize, in: viewSize)
        guard !image.isEmpty else { return .zero }
        let rect = CGRect(
            x: image.minX + CGFloat(box.x) * image.width,
            y: image.minY + CGFloat(box.y) * image.height,
            width: CGFloat(box.width) * image.width,
            height: CGFloat(box.height) * image.height
        )
        return rect.intersection(image)
    }

    /// The face's rect on screen: the unzoomed rect scaled by the scroll view's `zoomScale`
    /// and shifted by its `contentOffset` (the pan), in the coordinates of a view that
    /// overlays the scroll view's frame.
    static func rect(
        for box: FaceBoxDTO,
        imageSize: CGSize,
        in viewSize: CGSize,
        zoomScale: CGFloat,
        contentOffset: CGPoint
    ) -> CGRect {
        let base = rect(for: box, imageSize: imageSize, in: viewSize)
        guard !base.isNull, !base.isEmpty else { return .zero }
        return CGRect(
            x: base.minX * zoomScale - contentOffset.x,
            y: base.minY * zoomScale - contentOffset.y,
            width: base.width * zoomScale,
            height: base.height * zoomScale
        )
    }
}
