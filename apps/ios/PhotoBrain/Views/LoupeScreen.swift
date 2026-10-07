import SwiftUI

struct LoupeScreen: View {
    let records: [PhotoRecord]
    @Binding var activeID: Int
    let api: any PhotoBrainAPI
    @ObservedObject var curation: PhotoCurationCenter
    let collections: CollectionsStore
    let dismiss: () -> Void
    /// Set when presented from Review: shows Reject/Keep instead of rating and flag controls.
    var review: LoupeReviewActions?
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    @State private var chromeVisible = true
    @State private var showingInfo = false
    @State private var similarSource: PhotoRecord?
    @State private var collectionSheetPhotoID: CollectionSheetTarget?
    @StateObject private var exports: ExportStore
    /// The open page's video or Live Photo player; released on page change and dismissal.
    @StateObject private var playback = LoupePlaybackController()
    /// Show Faces: boxes over the paged photos while on.
    @StateObject private var faceBoxes: LoupeFaceBoxesStore
    @Environment(\.showInLibrary) private var showInLibrary

    init(
        records: [PhotoRecord],
        activeID: Binding<Int>,
        api: any PhotoBrainAPI,
        curation: PhotoCurationCenter,
        collections: CollectionsStore,
        dismiss: @escaping () -> Void,
        review: LoupeReviewActions? = nil
    ) {
        self.records = records
        _activeID = activeID
        self.api = api
        self.curation = curation
        self.collections = collections
        self.dismiss = dismiss
        self.review = review
        _exports = StateObject(wrappedValue: ExportStore(api: api))
        _faceBoxes = StateObject(wrappedValue: LoupeFaceBoxesStore(api: api))
    }

    private var activeRecord: PhotoRecord? {
        records.first { $0.id == activeID }
    }

    /// Tag-chip/place-row action for this loupe: closes its sheets and the loupe itself, then
    /// forwards to the presenter's action so any enclosing loupe closes too before the Library
    /// is filtered.
    private var librarySelection: ShowInLibraryAction? {
        guard let showInLibrary else { return nil }
        return ShowInLibraryAction { shortcut in
            showingInfo = false
            similarSource = nil
            collectionSheetPhotoID = nil
            dismiss()
            showInLibrary(shortcut)
        }
    }

    var body: some View {
        ZStack {
            Color.black.ignoresSafeArea()
            PagedLoupe(
                records: records,
                activeID: $activeID,
                playback: playback,
                chromeVisible: chromeVisible,
                onTap: {
                    if reduceMotion {
                        chromeVisible.toggle()
                    } else {
                        withAnimation(.easeInOut(duration: 0.18)) {
                            chromeVisible.toggle()
                        }
                    }
                },
                onEmpty: dismiss,
                faceBoxes: faceBoxes.visibleBoxes
            )
            .ignoresSafeArea()

            if chromeVisible {
                VStack(spacing: PBSpacing.s) {
                    topChrome
                    if let message = review?.errorMessage {
                        PBBanner(message: "Couldn’t save review. \(message)", dismiss: { review?.dismissError() })
                    } else if case let .failed(failure) = exports.state {
                        PBBanner(
                            message: "Couldn’t share. \(failure.message)",
                            retry: failure.retryTarget.map { _ in { exports.retry() } },
                            dismiss: exports.dismissError
                        )
                    } else if let message = curation.errorMessage {
                        PBBanner(message: "Couldn’t save rating. \(message)", dismiss: { curation.dismissError() })
                    }
                    overlayControls
                    Spacer()
                    filmstrip
                    if let activeRecord {
                        if let review {
                            reviewBar(activeRecord, review: review)
                        } else {
                            curationBar(activeRecord)
                        }
                    }
                }
                .padding(.bottom, PBSpacing.xs)
                .transition(.opacity)
            }
        }
        .preferredColorScheme(.dark)
        .onAppear { playback.show(activeRecord) }
        .onChange(of: activeID) { _, _ in
            playback.show(activeRecord)
            Task { await faceBoxes.load(activeRecord) }
        }
        .onDisappear { playback.release() }
        .statusBarHidden(!chromeVisible)
        .exportPresentation(exports)
        .sheet(isPresented: $showingInfo) {
            if let activeRecord {
                PhotoMetadataView(photo: activeRecord, api: api, onSelect: librarySelection)
                    .id(activeRecord.id)
            }
        }
        .sheet(item: $similarSource) { source in
            SimilarPhotosScreen(source: source, api: api, curation: curation, collections: collections) {
                similarSource = nil
            }
            .environment(\.showInLibrary, librarySelection)
        }
        .sheet(item: $collectionSheetPhotoID) { target in
            AddToCollectionSheet(photoID: target.id, collections: collections)
        }
        .accessibilityAction(named: chromeVisible ? "Hide controls" : "Show controls") {
            chromeVisible.toggle()
        }
    }

    /// Close, a centered title (place when known, else date; date and time beneath), and Info.
    private var topChrome: some View {
        HStack(spacing: PBSpacing.m) {
            GlassIconButton(systemImage: "chevron.down", accessibilityLabel: "Close photo", dark: true, action: dismiss)
            Spacer(minLength: 0)
            if let activeRecord {
                LoupeTitle(photo: activeRecord, api: api, position: position)
                    .id(activeRecord.id)
            }
            Spacer(minLength: 0)
            GlassIconButton(systemImage: "info", accessibilityLabel: "Photo info", dark: true) {
                showingInfo = true
            }
            .disabled(activeRecord == nil)
        }
        .padding(.horizontal, PBSpacing.m)
        .padding(.top, PBSpacing.xs)
    }

    /// `(index, count)` of the open photo, for the title's accessibility value.
    private var position: (Int, Int) {
        ((records.firstIndex { $0.id == activeID } ?? 0) + 1, records.count)
    }

    /// Share (export sizes) and everything else that acts on the open photo.
    private var moreMenu: some View {
        Menu {
            if let activeRecord {
                Section {
                    Button {
                        collectionSheetPhotoID = CollectionSheetTarget(id: activeRecord.id)
                    } label: {
                        Label("Add to Collection", systemImage: "rectangle.stack.badge.plus")
                    }
                    Button {
                        similarSource = activeRecord
                    } label: {
                        Label("Find Similar", systemImage: "sparkle.magnifyingglass")
                    }
                    if !activeRecord.isVideo {
                        Button {
                            let record = activeRecord
                            Task { await faceBoxes.setShowing(!faceBoxes.isShowing, photo: record) }
                        } label: {
                            Label(
                                faceBoxes.isShowing ? "Hide Faces" : "Show Faces",
                                systemImage: faceBoxes.isShowing ? "person.crop.square.fill" : "person.crop.square"
                            )
                        }
                    }
                }
            }
        } label: {
            GlassIconLabel(systemImage: "ellipsis", dark: true)
        }
        .disabled(activeRecord == nil)
        .accessibilityLabel("More")
    }

    private var shareMenu: some View {
        Menu {
            if let activeRecord {
                ForEach(PhotoShareOption.options(for: activeRecord)) { option in
                    Button {
                        exports.start(.photo(id: activeRecord.id, size: option.size))
                    } label: {
                        Label(option.title, systemImage: option.systemImage)
                    }
                }
            }
        } label: {
            GlassIconLabel(systemImage: "square.and.arrow.up", dark: true)
        }
        .disabled(activeRecord == nil || exports.isBusy)
        .accessibilityLabel("Share")
    }

    /// Share, a glass capsule with stars and Pick/Reject, and More.
    private func curationBar(_ photo: PhotoRecord) -> some View {
        let current = PhotoCuration(photo)
        return HStack(spacing: PBSpacing.s) {
            shareMenu
            Spacer(minLength: 0)
            HStack(spacing: 0) {
                ForEach(1...5, id: \.self) { stars in
                    Button {
                        curation.update(photo, patch: .toggledRating(stars, current: current))
                    } label: {
                        Image(systemName: stars <= current.rating ? "star.fill" : "star")
                            .font(.subheadline.weight(.semibold))
                            .foregroundStyle(stars <= current.rating ? PBColor.rating : Color.white.opacity(0.85))
                            .frame(width: 30, height: PBSize.control)
                            .contentShape(Rectangle())
                    }
                    .accessibilityLabel(stars == 1 ? "Rate 1 star" : "Rate \(stars) stars")
                    .accessibilityAddTraits(current.rating == stars ? .isSelected : [])
                }
                Divider()
                    .frame(height: 20)
                    .overlay(Color.white.opacity(0.3))
                    .padding(.horizontal, PBSpacing.xs)
                flagButton(photo, current: current, flag: .pick)
                flagButton(photo, current: current, flag: .reject)
            }
            .buttonStyle(.plain)
            .padding(.horizontal, PBSpacing.s)
            .pbGlass(in: Capsule(), dark: true)
            .fixedSize()
            Spacer(minLength: 0)
            moreMenu
        }
        .padding(.horizontal, PBSpacing.m)
    }

    private func flagButton(_ photo: PhotoRecord, current: PhotoCuration, flag: PhotoFlag) -> some View {
        let isOn = current.flag == flag
        let symbol = flag == .pick ? "flag" : "xmark.circle"
        let color = flag == .pick ? PBColor.pick : PBColor.reject
        return Button {
            curation.update(photo, patch: .toggledFlag(flag, current: current))
        } label: {
            Image(systemName: isOn ? "\(symbol).fill" : symbol)
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(isOn ? color : Color.white.opacity(0.85))
                .frame(width: 36, height: PBSize.control)
                .contentShape(Rectangle())
        }
        .accessibilityLabel(flag == .pick ? "Pick" : "Reject")
        .accessibilityAddTraits(isOn ? .isSelected : [])
    }

    private func reviewBar(_ photo: PhotoRecord, review: LoupeReviewActions) -> some View {
        VStack(spacing: 6) {
            if !photo.junkReasons.isEmpty {
                Text(photo.junkReasons.map(\.title).joined(separator: " · "))
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(.secondary)
                    .accessibilityLabel("Why it's here: \(photo.junkReasons.map(\.title).joined(separator: ", "))")
            }
            HStack(spacing: 12) {
                Button(role: .destructive) {
                    review.resolve(.reject)
                } label: {
                    Label("Reject", systemImage: "xmark.circle")
                        .frame(maxWidth: .infinity)
                }
                .tint(.red)
                Button {
                    review.resolve(.keep)
                } label: {
                    Label("Keep", systemImage: "checkmark.circle")
                        .frame(maxWidth: .infinity)
                }
                .tint(.white)
            }
            .buttonStyle(.bordered)
            .controlSize(.large)
        }
        .padding(PBSpacing.m)
        .pbGlass(in: RoundedRectangle(cornerRadius: PBRadius.hero, style: .continuous), dark: true)
        .padding(.horizontal, PBSpacing.m)
    }

    /// Compact Photos-style strip: narrow frames with the open photo widened and outlined.
    private var filmstrip: some View {
        let height: CGFloat = dynamicTypeSize.isAccessibilitySize ? 56 : 40
        return ScrollViewReader { proxy in
            ScrollView(.horizontal, showsIndicators: false) {
                LazyHStack(spacing: 2) {
                    ForEach(records) { photo in
                        let isActive = photo.id == activeID
                        Button {
                            activeID = photo.id
                        } label: {
                            RemotePhotoImage(
                                photo: photo,
                                url: photo.thumbnailURL,
                                contentMode: .fill,
                                showsRetry: false,
                                targetSize: CGSize(width: height * 1.4, height: height)
                            ) {
                                Color(uiColor: SyntheticThumbnail.color(id: photo.id))
                            }
                            .frame(width: isActive ? height * 1.4 : height * 0.62, height: height)
                            .clipped()
                            .opacity(photo.isRejected ? 0.35 : 1)
                            .clipShape(RoundedRectangle(cornerRadius: 3, style: .continuous))
                            .overlay {
                                RoundedRectangle(cornerRadius: 3, style: .continuous)
                                    .stroke(isActive ? Color.white : Color.clear, lineWidth: 2)
                            }
                            .padding(.horizontal, isActive ? 4 : 0)
                        }
                        .buttonStyle(.plain)
                        .id(photo.id)
                        .accessibilityLabel("Open \(photo.filename)")
                        .accessibilityAddTraits(isActive ? .isSelected : [])
                    }
                }
                .padding(.vertical, 2)
            }
            .contentMargins(.horizontal, 160, for: .scrollContent)
            .frame(height: height + 4)
            .onAppear { proxy.scrollTo(activeID, anchor: .center) }
            .onChange(of: activeID) { _, newID in
                if reduceMotion {
                    proxy.scrollTo(newID, anchor: .center)
                } else {
                    withAnimation(.easeOut(duration: 0.2)) {
                        proxy.scrollTo(newID, anchor: .center)
                    }
                }
            }
        }
    }

    /// LIVE (for Live Photos) and Show Faces (for stills) over the top of the photo.
    @ViewBuilder
    private var overlayControls: some View {
        let hasLive = activeRecord?.motionVideoURL != nil
        let canShowFaces = faceBoxes.isShowing && (activeRecord.map { !$0.isVideo } ?? false)
        if hasLive || canShowFaces {
            HStack(spacing: 8) {
                if hasLive { liveButton }
                if canShowFaces { facesButton }
                Spacer()
            }
            .padding(.horizontal, PBSpacing.m)
        }
    }

    /// Outlines detected faces on the photo; they follow pinch-zoom and pan.
    private var facesButton: some View {
        let showing = faceBoxes.isShowing
        let count = activeRecord.flatMap { faceBoxes.faceCount(photoID: $0.id) }
        let failed = activeRecord.map { faceBoxes.failedPhotoIDs.contains($0.id) } ?? false
        return Button {
            let record = activeRecord
            Task { await faceBoxes.setShowing(!showing, photo: record) }
        } label: {
            Label(
                showing && count == 0 ? "No Faces" : "Faces",
                systemImage: showing ? "person.crop.square.fill" : "person.crop.square"
            )
            .font(.caption.weight(.semibold))
            .padding(.horizontal, 12)
            .padding(.vertical, 7)
            .foregroundStyle(Color.yellow)
            .pbGlass(in: Capsule(), interactive: true, dark: true)
        }
        .buttonStyle(.plain)
        .accessibilityLabel("Show Faces")
        .accessibilityValue(facesAccessibilityValue(showing: showing, count: count, failed: failed))
        .accessibilityAddTraits(showing ? .isSelected : [])
    }

    private func facesAccessibilityValue(showing: Bool, count: Int?, failed: Bool) -> String {
        guard showing else { return "Off" }
        if failed { return "On, faces unavailable" }
        guard let count else { return "On, loading" }
        return count == 0 ? "On, no faces found" : "On, \(CountText.of(count, "face", "faces"))"
    }

    /// Plays the still's motion clip once, muted, over the still; disabled while it plays.
    private var liveButton: some View {
        let playing = playback.isPlayingLive
        return Button {
            playback.playLive()
        } label: {
            Label("LIVE", systemImage: "livephoto")
                .font(.caption.weight(.semibold))
                .padding(.horizontal, 12)
                .padding(.vertical, 7)
                .foregroundStyle(playing ? Color.yellow : Color.white)
                .pbGlass(in: Capsule(), interactive: true, dark: true)
        }
        .buttonStyle(.plain)
        .disabled(playing)
        .accessibilityLabel("Play Live Photo")
        .accessibilityValue(playing ? "Playing" : "")
    }

}

private struct CollectionSheetTarget: Identifiable {
    let id: Int
}

/// Review-mode hooks for the loupe. `resolve` decides the open photo and advances.
struct LoupeReviewActions {
    let errorMessage: String?
    let resolve: @MainActor (JunkAction) -> Void
    let dismissError: @MainActor () -> Void
}

private struct PhotoMetadataView: View {
    let photo: PhotoRecord
    /// Nil when no Library is reachable; chips and the place row then render without an action.
    let onSelect: ShowInLibraryAction?
    @StateObject private var tags: PhotoTagsStore
    @StateObject private var place: PhotoPlaceStore
    @StateObject private var pair: PhotoPairStore
    @StateObject private var faces: PhotoFacesStore
    @State private var assigningFace: PhotoFaceDTO?
    @Environment(\.peopleStore) private var people
    @Environment(\.dismiss) private var dismiss

    init(photo: PhotoRecord, api: any PhotoBrainAPI, onSelect: ShowInLibraryAction?) {
        self.photo = photo
        self.onSelect = onSelect
        _tags = StateObject(wrappedValue: PhotoTagsStore(photoID: photo.id, api: api))
        _place = StateObject(wrappedValue: PhotoPlaceStore(photoID: photo.id, api: api))
        _pair = StateObject(wrappedValue: PhotoPairStore(photo: photo, api: api))
        _faces = StateObject(wrappedValue: PhotoFacesStore(photoID: photo.id, api: api))
    }

    var body: some View {
        NavigationStack {
            List {
                Section {
                    PhotoInfoSummary(photo: photo)
                        .listRowInsets(EdgeInsets(top: PBSpacing.m, leading: PBSpacing.l, bottom: PBSpacing.m, trailing: PBSpacing.l))
                }
                Section("Tags") {
                    tagContent
                }
                if !photo.isVideo {
                    Section("People") {
                        PhotoFacesSection(faces: faces, apiBaseURL: faces.api.baseURL) { face in
                            assigningFace = face
                        }
                    }
                }
                Section("File") {
                    row("Name", photo.filename)
                    row("Size", photo.fileSize.map { ByteCountFormatter.string(fromByteCount: Int64($0), countStyle: .file) })
                    if photo.pixelWidth > 0, photo.pixelHeight > 0 {
                        row("Dimensions", "\(photo.pixelWidth) × \(photo.pixelHeight)")
                    }
                    row("Type", photo.mimeType)
                    if photo.isVideo {
                        row("Duration", VideoDuration.text(milliseconds: photo.durationMs))
                        row("Codec", photo.videoCodec?.uppercased())
                    }
                    row("Created", formatted(photo.createdDate))
                    row("Modified", formatted(photo.modifiedDate))
                    row("Thumbnail", photo.thumbnailStatus)
                    row("Search Index", photo.embeddingStatus)
                    row("Perceptual Hash", photo.phashStatus)
                }

                if photo.isRaw {
                    Section("RAW") {
                        row("Format", photo.rawFormat)
                        row("Status", rawStatus)
                        row("Error", photo.rawError)
                    }
                }

                if let partner = pair.partner {
                    Section("Pair") {
                        row("Partner", partner.filename)
                        row("Format", partner.format)
                    }
                }

                if let exif = photo.exif {
                    Section("Camera") {
                        row("Make", exif.cameraMake)
                        row("Model", exif.cameraModel)
                        row("Lens Make", exif.lensMake)
                        row("Lens", exif.lensModel)
                    }
                    Section("Exposure") {
                        row("Focal Length", exif.focalLength.map { "\($0) mm" })
                        row("Aperture", exif.aperture)
                        row("Shutter", exif.shutterSpeed)
                        row("ISO", exif.iso.map { "ISO \($0)" })
                        row("Exposure Bias", exif.exposureBias)
                    }
                    Section("Date") {
                        row("Taken", exif.dateTaken)
                    }
                    Section("Location") {
                        if let loaded = place.place {
                            placeRow(loaded)
                        }
                        if let coordinate = PhotoCoordinate(exif: exif) {
                            PhotoLocationMiniMap(coordinate: coordinate)
                            row("Coordinates", coordinate.formatted)
                        } else {
                            row("Latitude", exif.gpsLatitude)
                            row("Longitude", exif.gpsLongitude)
                        }
                        row("Altitude", exif.gpsAltitude)
                    }
                }
            }
            .task { await tags.load() }
            .task {
                // Only geotagged photos (by the server's validity rule) can have a place.
                guard PhotoCoordinate(exif: photo.exif) != nil else { return }
                await place.load()
            }
            .task { await pair.load() }
            .task {
                guard !photo.isVideo else { return }
                faces.onAssigned = { [weak people] in people?.refreshInBackground() }
                await faces.load()
            }
            .sheet(item: $assigningFace) { face in
                FaceAssignSheet(face: face, api: faces.api, people: people) { target, displayName in
                    Task { await faces.assign(faceId: face.id, to: target, displayName: displayName) }
                }
            }
            .navigationTitle(photo.isVideo ? "Video Info" : "Photo Info")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") { dismiss() }
                }
            }
        }
        .presentationDetents([.medium, .large])
        .presentationDragIndicator(.visible)
        .presentationBackgroundInteraction(.enabled(upThrough: .medium))
    }

    @ViewBuilder
    private var tagContent: some View {
        switch tags.state {
        case .loading:
            HStack(spacing: 8) {
                ProgressView()
                Text("Loading tags…").foregroundStyle(.secondary)
            }
        case let .failed(message):
            VStack(alignment: .leading, spacing: 6) {
                Text("Tags are unavailable.")
                Text(message).font(.caption).foregroundStyle(.secondary)
                Button("Try Again") { Task { await tags.load() } }
            }
        case let .loaded(loaded) where loaded.isEmpty:
            Text("No tags yet").foregroundStyle(.secondary)
        case let .loaded(loaded):
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 8) {
                    ForEach(loaded) { tag in
                        tagChip(tag)
                    }
                }
                .padding(.vertical, 2)
            }
        }
    }

    @ViewBuilder
    private func tagChip(_ tag: PhotoTagDTO) -> some View {
        let name = PhotoTagName.displayName(tag.tag)
        let label = Text(name)
            .font(.subheadline)
            .lineLimit(1)
            .padding(.horizontal, PBSpacing.m)
            .padding(.vertical, 6)
            .foregroundStyle(PBColor.accent)
            .background(Capsule().fill(PBColor.accent.opacity(0.15)))
        if let onSelect {
            Button {
                onSelect(.tag(tag.tag))
            } label: {
                label
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Tag \(name)")
            .accessibilityHint("Shows Library photos tagged \(name)")
        } else {
            label.accessibilityLabel("Tag \(name)")
        }
    }

    @ViewBuilder
    private func placeRow(_ loaded: PhotoPlaceDTO) -> some View {
        let label = PlaceName.label(loaded)
        if let onSelect {
            Button {
                onSelect(.place(loaded))
            } label: {
                LabeledContent("Place") {
                    HStack(spacing: 4) {
                        Text(label).multilineTextAlignment(.trailing)
                        Image(systemName: "chevron.right")
                            .font(.caption.weight(.semibold))
                            .foregroundStyle(.tertiary)
                    }
                }
            }
            .foregroundStyle(.primary)
            .accessibilityLabel("Place, \(label)")
            .accessibilityHint("Shows Library photos taken in \(loaded.city)")
        } else {
            row("Place", label)
        }
    }

    private var rawStatus: String? {
        switch photo.rawStatus {
        case .some("converted"): "Converted"
        case .some("failed"): "Failed"
        case .some("no_converter"): "No Converter"
        case .some(_): "Pending"
        case .none: nil
        }
    }

    private func formatted(_ date: Date?) -> String? {
        date?.formatted(.dateTime.year().month().day().hour().minute().second())
    }

    @ViewBuilder
    private func row(_ label: String, _ value: String?) -> some View {
        if let value, !value.isEmpty {
            LabeledContent(label) {
                Text(value)
                    .multilineTextAlignment(.trailing)
                    .textSelection(.enabled)
            }
        }
    }
}

/// The loupe's centered glass title: the photo's city when it has one, else its date, with
/// the date and time beneath. The place loads only for geotagged photos.
private struct LoupeTitle: View {
    let photo: PhotoRecord
    let position: (Int, Int)
    @StateObject private var place: PhotoPlaceStore

    init(photo: PhotoRecord, api: any PhotoBrainAPI, position: (Int, Int)) {
        self.photo = photo
        self.position = position
        _place = StateObject(wrappedValue: PhotoPlaceStore(photoID: photo.id, api: api))
    }

    var body: some View {
        let date = PhotoDateResolver.date(for: photo)
        VStack(spacing: 0) {
            if let city = place.place?.city {
                Text(city)
                    .font(.subheadline.weight(.semibold))
                Text(date, format: .dateTime.month(.abbreviated).day().year().hour().minute())
                    .font(.caption2)
                    .foregroundStyle(.white.opacity(0.75))
            } else {
                Text(date, format: .dateTime.month(.abbreviated).day().year())
                    .font(.subheadline.weight(.semibold))
                Text(date, format: .dateTime.hour().minute())
                    .font(.caption2)
                    .foregroundStyle(.white.opacity(0.75))
            }
        }
        .lineLimit(1)
        .minimumScaleFactor(0.8)
        .foregroundStyle(.white)
        .padding(.horizontal, PBSpacing.l)
        .frame(minHeight: PBSize.control)
        .pbGlass(in: Capsule(), dark: true)
        .accessibilityElement(children: .combine)
        .accessibilityValue("Photo \(position.0) of \(position.1)")
        .task {
            guard PhotoCoordinate(exif: photo.exif) != nil else { return }
            await place.load()
        }
    }
}

/// The info sheet's header card: weekday, date and file name, then camera, lens, and an
/// exposure strip (ISO, focal length, aperture, shutter, format).
private struct PhotoInfoSummary: View {
    let photo: PhotoRecord

    var body: some View {
        let date = PhotoDateResolver.date(for: photo)
        VStack(alignment: .leading, spacing: PBSpacing.m) {
            VStack(alignment: .leading, spacing: 2) {
                Text(date, format: .dateTime.weekday(.wide))
                    .font(.title3.weight(.bold))
                Text("\(date.formatted(.dateTime.month(.wide).day().year().hour().minute())) · \(photo.filename)")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                    .lineLimit(2)
            }
            if let exif = photo.exif, exif.cameraDescription != nil || exif.lensModel != nil || !exposure.isEmpty {
                VStack(alignment: .leading, spacing: PBSpacing.s) {
                    if let camera = exif.cameraDescription {
                        Text(camera).font(.subheadline.weight(.semibold))
                    }
                    if let lens = exif.lensModel {
                        Text(lens).font(.footnote).foregroundStyle(.secondary)
                    }
                    if !exposure.isEmpty {
                        HStack {
                            ForEach(Array(exposure.enumerated()), id: \.offset) { index, value in
                                if index > 0 { Spacer(minLength: PBSpacing.xs) }
                                Text(value)
                            }
                        }
                        .font(.caption.monospacedDigit().weight(.medium))
                        .padding(.top, 2)
                    }
                }
                .padding(PBSpacing.m)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(
                    RoundedRectangle(cornerRadius: PBRadius.card, style: .continuous)
                        .fill(Color(uiColor: .tertiarySystemFill))
                )
            }
        }
        .accessibilityElement(children: .combine)
    }

    private var exposure: [String] {
        guard let exif = photo.exif else { return [] }
        var values: [String] = []
        if let iso = exif.iso { values.append("ISO \(iso)") }
        if let focal = exif.focalLength { values.append("\(focal) mm") }
        if let aperture = exif.aperture { values.append(aperture.hasPrefix("f") || aperture.hasPrefix("ƒ") ? aperture : "ƒ\(aperture)") }
        if let shutter = exif.shutterSpeed { values.append(shutter) }
        if let format = photo.formatBadge { values.append(format) }
        return values
    }
}
