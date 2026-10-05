import MapKit
import SwiftUI

/// Every geotagged photo matching the Library's filters on a clustered map. A marker opens
/// its photo in the loupe, a cluster zooms to its members, and "Show N Photos" lists the
/// visible region in the Library grid.
struct MapScreen: View {
    let collections: CollectionsStore
    @StateObject private var store: MapStore
    @State private var areaFilters: LibraryFilters?

    init(filters: LibraryFilters, collections: CollectionsStore, curation: PhotoCurationCenter, api: any PhotoBrainAPI) {
        self.collections = collections
        _store = StateObject(wrappedValue: MapStore(filters: filters, api: api, curation: curation))
    }

    var body: some View {
        content
            .navigationTitle("Map")
            .navigationBarTitleDisplayMode(.inline)
            .task {
                if store.state == .idle { await store.load() }
            }
            .navigationDestination(item: $areaFilters) { filters in
                MapAreaPhotosScreen(filters: filters, collections: collections, curation: store.curation, api: store.api)
            }
            .fullScreenCover(isPresented: loupePresented) {
                if let record = store.openRecord {
                    LoupeScreen(
                        records: [record],
                        activeID: .constant(record.id),
                        api: store.api,
                        curation: store.curation,
                        collections: collections,
                        dismiss: { store.openRecord = nil }
                    )
                }
            }
    }

    @ViewBuilder
    private var content: some View {
        switch store.state {
        case .idle, .loading:
            ProgressView("Loading Map…")
                .frame(maxWidth: .infinity, maxHeight: .infinity)
        case let .failed(message):
            ContentUnavailableView {
                Label("Map Unavailable", systemImage: "wifi.exclamationmark")
            } description: {
                Text(message)
            } actions: {
                Button("Try Again") { Task { await store.load() } }
                    .buttonStyle(.borderedProminent)
            }
        case .empty:
            ContentUnavailableView(
                "No Photos with Locations",
                systemImage: "map",
                description: Text(store.filters.isActive
                    ? "No matching photos have GPS coordinates. Try clearing one or more filters."
                    : "Photos with GPS coordinates appear here.")
            )
        case .loaded:
            PhotoClusterMap(
                points: store.points,
                pointsVersion: store.pointsVersion,
                onRegionChange: store.setVisibleBounds,
                onSelectPhoto: { id in Task { await store.openPhoto(id: id) } },
                onShowArea: { bounds in
                    var filters = store.filters
                    filters.bounds = bounds
                    areaFilters = filters
                }
            )
            .ignoresSafeArea(edges: [.horizontal, .bottom])
            .safeAreaInset(edge: .top, spacing: 0) {
                if let message = store.openError {
                    ErrorBanner(message: "Couldn’t open the photo. \(message)", dismiss: { store.dismissOpenError() })
                }
            }
            .overlay {
                if store.isOpeningPhoto {
                    ProgressView()
                        .padding(16)
                        .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 12))
                }
            }
            .safeAreaInset(edge: .bottom, spacing: 0) {
                showPhotosButton
            }
        }
    }

    private var showPhotosButton: some View {
        let count = store.visibleCount
        return Button {
            areaFilters = store.visibleAreaFilters
        } label: {
            Text(count == 1 ? "Show 1 Photo" : "Show \(count.formatted()) Photos")
                .fontWeight(.semibold)
                .contentTransition(.numericText())
                .frame(maxWidth: .infinity, minHeight: 44)
        }
        .buttonStyle(.borderedProminent)
        .disabled(count == 0 || store.visibleAreaFilters == nil)
        .padding(.horizontal, 16)
        .padding(.bottom, 12)
    }

    private var loupePresented: Binding<Bool> {
        Binding(
            get: { store.openRecord != nil },
            set: { if !$0 { store.openRecord = nil } }
        )
    }
}

/// "Show N Photos": the Library's filters plus the map region, in the scoped Library grid.
struct MapAreaPhotosScreen: View {
    let collections: CollectionsStore
    let api: any PhotoBrainAPI
    @StateObject private var store: LibraryStore

    init(filters: LibraryFilters, collections: CollectionsStore, curation: PhotoCurationCenter, api: any PhotoBrainAPI) {
        self.collections = collections
        self.api = api
        _store = StateObject(wrappedValue: LibraryStore(api: api, curation: curation, scope: .mapArea, filters: filters))
    }

    var body: some View {
        ScopedPhotoGrid(
            store: store,
            collections: collections,
            api: api,
            title: "Photos in This Area",
            noun: "Photos",
            emptyTitle: "No Photos",
            emptyDescription: "No matching photos are in this area anymore.",
            onRefresh: {}
        )
    }
}

/// `MKMapView` with clustered photo markers (SwiftUI `Map` cannot cluster).
private struct PhotoClusterMap: UIViewRepresentable {
    let points: [PhotoLocationPointDTO]
    /// Changes when `points` is replaced; the map then refits its region to every point.
    let pointsVersion: Int
    let onRegionChange: (PhotoBounds) -> Void
    let onSelectPhoto: (Int) -> Void
    /// Opens the grid for a region; used for clusters whose photos share one location.
    let onShowArea: (PhotoBounds) -> Void

    private static let clusteringIdentifier = "photo"

    func makeCoordinator() -> Coordinator {
        Coordinator(parent: self)
    }

    func makeUIView(context: Context) -> FittingMapView {
        let mapView = FittingMapView()
        mapView.delegate = context.coordinator
        mapView.pointOfInterestFilter = .excludingAll
        mapView.showsCompass = true
        mapView.register(
            MKMarkerAnnotationView.self,
            forAnnotationViewWithReuseIdentifier: MKMapViewDefaultAnnotationViewReuseIdentifier
        )
        mapView.register(
            MKMarkerAnnotationView.self,
            forAnnotationViewWithReuseIdentifier: MKMapViewDefaultClusterAnnotationViewReuseIdentifier
        )
        return mapView
    }

    func updateUIView(_ mapView: FittingMapView, context: Context) {
        let coordinator = context.coordinator
        coordinator.parent = self
        guard coordinator.pointsVersion != pointsVersion else { return }
        coordinator.pointsVersion = pointsVersion
        mapView.removeAnnotations(mapView.annotations)
        let annotations = points.map(PhotoPointAnnotation.init)
        mapView.addAnnotations(annotations)
        mapView.fit(annotations)
    }

    final class PhotoPointAnnotation: NSObject, MKAnnotation {
        let photoID: Int
        let coordinate: CLLocationCoordinate2D

        init(_ point: PhotoLocationPointDTO) {
            photoID = point.id
            coordinate = CLLocationCoordinate2D(latitude: point.latitude, longitude: point.longitude)
        }
    }

    /// Defers fitting until the view has a size, so the first fit is not against a zero frame.
    final class FittingMapView: MKMapView {
        private var pendingFit: [MKAnnotation]?

        func fit(_ annotations: [MKAnnotation]) {
            pendingFit = annotations
            setNeedsLayout()
        }

        override func layoutSubviews() {
            super.layoutSubviews()
            guard let annotations = pendingFit, bounds.width > 0, bounds.height > 0 else { return }
            pendingFit = nil
            showAnnotations(annotations, animated: false)
            // MapKit clamps how far out it zooms (about 100° of longitude on a portrait phone),
            // so photos on distant continents leave the clamped fit centered between them with
            // none on screen. Open on the largest group that fits instead.
            let densest = MapFit.densestSpan(
                xs: annotations.map { MKMapPoint($0.coordinate).x },
                width: visibleMapRect.width,
                worldWidth: MKMapRect.world.width
            )
            if densest.count < annotations.count {
                showAnnotations(densest.map { annotations[$0] }, animated: false)
            }
        }
    }

    @MainActor
    final class Coordinator: NSObject, MKMapViewDelegate {
        var parent: PhotoClusterMap
        var pointsVersion: Int?

        init(parent: PhotoClusterMap) {
            self.parent = parent
        }

        func mapView(_ mapView: MKMapView, viewFor annotation: MKAnnotation) -> MKAnnotationView? {
            if let cluster = annotation as? MKClusterAnnotation {
                let view = mapView.dequeueReusableAnnotationView(
                    withIdentifier: MKMapViewDefaultClusterAnnotationViewReuseIdentifier,
                    for: cluster
                ) as? MKMarkerAnnotationView
                view?.markerTintColor = .systemIndigo
                view?.displayPriority = .required
                view?.accessibilityLabel = CountText.photos(cluster.memberAnnotations.count)
                return view
            }
            guard let photo = annotation as? PhotoPointAnnotation else { return nil }
            let view = mapView.dequeueReusableAnnotationView(
                withIdentifier: MKMapViewDefaultAnnotationViewReuseIdentifier,
                for: photo
            ) as? MKMarkerAnnotationView
            view?.clusteringIdentifier = PhotoClusterMap.clusteringIdentifier
            view?.glyphImage = UIImage(systemName: "photo")
            view?.markerTintColor = .systemIndigo
            view?.displayPriority = .defaultHigh
            view?.accessibilityLabel = "Photo"
            return view
        }

        func mapView(_ mapView: MKMapView, didSelect annotation: MKAnnotation) {
            mapView.deselectAnnotation(annotation, animated: false)
            if let cluster = annotation as? MKClusterAnnotation {
                let members = cluster.memberAnnotations
                if let first = members.first, members.allSatisfy({ $0.coordinate.latitude == first.coordinate.latitude
                    && $0.coordinate.longitude == first.coordinate.longitude }) {
                    // Zooming can never separate photos taken at the same spot; list them instead.
                    let latitude = first.coordinate.latitude
                    let longitude = first.coordinate.longitude
                    parent.onShowArea(PhotoBounds(north: latitude, south: latitude, east: longitude, west: longitude))
                } else {
                    mapView.showAnnotations(members, animated: true)
                }
            } else if let photo = annotation as? PhotoPointAnnotation {
                parent.onSelectPhoto(photo.photoID)
            }
        }

        func mapView(_ mapView: MKMapView, regionDidChangeAnimated animated: Bool) {
            // `visibleMapRect` is the exact Mercator viewport; `region`'s span is an
            // approximation that undershoots badly when zoomed out to continents.
            let bounds = MapRegionBounds.bounds(visibleMapRect: mapView.visibleMapRect)
            // MapKit can report region changes while SwiftUI is updating this view.
            DispatchQueue.main.async { [parent] in parent.onRegionChange(bounds) }
        }
    }
}

/// Loupe info: a small non-interactive map with a marker at the photo's location.
struct PhotoLocationMiniMap: View {
    let coordinate: PhotoCoordinate

    var body: some View {
        let center = CLLocationCoordinate2D(latitude: coordinate.latitude, longitude: coordinate.longitude)
        Map(
            initialPosition: .region(MKCoordinateRegion(center: center, latitudinalMeters: 2_000, longitudinalMeters: 2_000)),
            interactionModes: []
        ) {
            Marker("", systemImage: "camera.fill", coordinate: center)
        }
        .mapStyle(.standard(pointsOfInterest: .excludingAll))
        .frame(height: 160)
        .clipShape(RoundedRectangle(cornerRadius: 10))
        .allowsHitTesting(false)
        .accessibilityElement()
        .accessibilityLabel("Map of the photo location, \(coordinate.formatted)")
    }
}
