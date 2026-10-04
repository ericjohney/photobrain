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
    @Environment(\.accessibilityReduceTransparency) private var reduceTransparency
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    @State private var chromeVisible = true
    @State private var showingInfo = false
    @State private var similarSource: PhotoRecord?
    @State private var collectionSheetPhotoID: CollectionSheetTarget?
    @StateObject private var exports: ExportStore
    /// The open page's video or Live Photo player; released on page change and dismissal.
    @StateObject private var playback = LoupePlaybackController()
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
                onEmpty: dismiss
            )
            .ignoresSafeArea()

            if chromeVisible {
                VStack(spacing: 0) {
                    topChrome
                    if let message = review?.errorMessage {
                        reviewError(message)
                    } else if case let .failed(failure) = exports.state {
                        ErrorBanner(
                            message: "Couldn’t share. \(failure.message)",
                            retry: failure.retryTarget.map { _ in { exports.retry() } },
                            dismiss: exports.dismissError
                        )
                    } else if let message = curation.errorMessage {
                        curationError(message)
                    }
                    if activeRecord?.motionVideoURL != nil {
                        liveButton
                    }
                    Spacer()
                    if let activeRecord {
                        if let review {
                            reviewBar(activeRecord, review: review)
                        } else {
                            curationBar(activeRecord)
                        }
                    }
                    filmstrip
                }
                .transition(.opacity)
            }
        }
        .preferredColorScheme(.dark)
        .onAppear { playback.show(activeRecord) }
        .onChange(of: activeID) { _, _ in playback.show(activeRecord) }
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

    private var topChrome: some View {
        HStack(spacing: 12) {
            Button(action: dismiss) {
                Image(systemName: "xmark")
                    .font(.headline)
                    .frame(width: 36, height: 36)
            }
            .accessibilityLabel("Close photo")
            Spacer(minLength: 4)
            if let activeRecord {
                VStack(spacing: 1) {
                    Text(PhotoDateResolver.date(for: activeRecord), format: .dateTime.month(.abbreviated).day().year())
                        .font(.subheadline.weight(.semibold))
                    Text(PhotoDateResolver.date(for: activeRecord), format: .dateTime.hour().minute())
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
                .lineLimit(1)
            }
            Spacer(minLength: 4)
            Text("\((records.firstIndex { $0.id == activeID } ?? 0) + 1) of \(records.count)")
                .font(.caption.monospacedDigit())
                .accessibilityLabel("Photo \((records.firstIndex { $0.id == activeID } ?? 0) + 1) of \(records.count)")
            shareMenu
            Button {
                collectionSheetPhotoID = activeRecord.map { CollectionSheetTarget(id: $0.id) }
            } label: {
                Image(systemName: "rectangle.stack.badge.plus")
                    .font(.title3)
                    .frame(width: 36, height: 36)
            }
            .disabled(activeRecord == nil)
            .accessibilityLabel("Add to Collection")
            Button {
                similarSource = activeRecord
            } label: {
                Image(systemName: "sparkle.magnifyingglass")
                    .font(.title3)
                    .frame(width: 36, height: 36)
            }
            .disabled(activeRecord == nil)
            .accessibilityLabel("Find Similar")
            Button {
                showingInfo = true
            } label: {
                Image(systemName: "info.circle")
                    .font(.title3)
                    .frame(width: 36, height: 36)
            }
            .accessibilityLabel("Photo info")
        }
        .padding(.horizontal, 12)
        .padding(.top, 4)
        .padding(.bottom, 8)
        .background(chromeBackground)
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
            Image(systemName: "square.and.arrow.up")
                .font(.title3)
                .frame(width: 36, height: 36)
        }
        .disabled(activeRecord == nil || exports.isBusy)
        .accessibilityLabel("Share")
    }

    private func curationBar(_ photo: PhotoRecord) -> some View {
        let current = PhotoCuration(photo)
        return HStack(spacing: 2) {
            ForEach(1...5, id: \.self) { stars in
                Button {
                    curation.update(photo, patch: .toggledRating(stars, current: current))
                } label: {
                    Image(systemName: stars <= current.rating ? "star.fill" : "star")
                        .font(.title3)
                        .foregroundStyle(stars <= current.rating ? Color.yellow : Color.white)
                        .frame(width: 40, height: 40)
                }
                .accessibilityLabel(stars == 1 ? "Rate 1 star" : "Rate \(stars) stars")
                .accessibilityAddTraits(current.rating == stars ? .isSelected : [])
            }
            Spacer(minLength: 8)
            Button {
                curation.update(photo, patch: .toggledFlag(.pick, current: current))
            } label: {
                Image(systemName: current.flag == .pick ? "flag.fill" : "flag")
                    .font(.title3)
                    .foregroundStyle(current.flag == .pick ? Color.green : Color.white)
                    .frame(width: 44, height: 40)
            }
            .accessibilityLabel("Pick")
            .accessibilityAddTraits(current.flag == .pick ? .isSelected : [])
            Button {
                curation.update(photo, patch: .toggledFlag(.reject, current: current))
            } label: {
                Image(systemName: current.flag == .reject ? "xmark.circle.fill" : "xmark.circle")
                    .font(.title3)
                    .foregroundStyle(current.flag == .reject ? Color.red : Color.white)
                    .frame(width: 44, height: 40)
            }
            .accessibilityLabel("Reject")
            .accessibilityAddTraits(current.flag == .reject ? .isSelected : [])
        }
        .buttonStyle(.plain)
        .padding(.horizontal, 12)
        .padding(.vertical, 2)
        .background(chromeBackground)
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
        .padding(.horizontal, 12)
        .padding(.vertical, 8)
        .background(chromeBackground)
    }

    private func reviewError(_ message: String) -> some View {
        HStack(spacing: 8) {
            Image(systemName: "exclamationmark.triangle.fill")
            Text("Couldn’t save review. \(message)")
                .lineLimit(2)
            Spacer(minLength: 4)
            Button {
                review?.dismissError()
            } label: {
                Image(systemName: "xmark")
                    .frame(width: 32, height: 32)
            }
            .accessibilityLabel("Dismiss error")
        }
        .font(.caption)
        .padding(.horizontal, 12)
        .padding(.vertical, 6)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color.orange.opacity(0.85))
        .accessibilityElement(children: .combine)
    }

    private func curationError(_ message: String) -> some View {
        HStack(spacing: 8) {
            Image(systemName: "exclamationmark.triangle.fill")
            Text("Couldn’t save rating. \(message)")
                .lineLimit(2)
            Spacer(minLength: 4)
            Button {
                curation.dismissError()
            } label: {
                Image(systemName: "xmark")
                    .frame(width: 32, height: 32)
            }
            .accessibilityLabel("Dismiss error")
        }
        .font(.caption)
        .padding(.horizontal, 12)
        .padding(.vertical, 6)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color.orange.opacity(0.85))
        .accessibilityElement(children: .combine)
    }

    private var filmstrip: some View {
        ScrollViewReader { proxy in
            ScrollView(.horizontal, showsIndicators: false) {
                LazyHStack(spacing: 4) {
                    ForEach(records) { photo in
                        Button {
                            activeID = photo.id
                        } label: {
                            RemotePhotoImage(
                                photo: photo,
                                url: photo.thumbnailURL,
                                contentMode: .fill,
                                showsRetry: false,
                                targetSize: CGSize(width: 58, height: 58)
                            ) {
                                Color(uiColor: SyntheticThumbnail.color(id: photo.id))
                            }
                            .frame(width: 58, height: 58)
                            .clipped()
                            .opacity(photo.isRejected ? 0.35 : 1)
                            .overlay {
                                RoundedRectangle(cornerRadius: 4)
                                    .stroke(photo.id == activeID ? Color.white : Color.clear, lineWidth: 3)
                            }
                            .clipShape(RoundedRectangle(cornerRadius: 4))
                        }
                        .buttonStyle(.plain)
                        .id(photo.id)
                        .accessibilityLabel("Open \(photo.filename)")
                        .accessibilityAddTraits(photo.id == activeID ? .isSelected : [])
                    }
                }
                .padding(.horizontal, 12)
                .padding(.vertical, 10)
            }
            .frame(height: dynamicTypeSize.isAccessibilitySize ? 92 : 78)
            .background(chromeBackground)
            .onAppear { proxy.scrollTo(activeID, anchor: .center) }
            .onChange(of: activeID) { _, newID in
                if reduceMotion {
                    proxy.scrollTo(newID, anchor: .center)
                } else {
                    withAnimation(.easeOut(duration: 0.15)) {
                        proxy.scrollTo(newID, anchor: .center)
                    }
                }
            }
        }
    }

    /// Plays the still's motion clip once, muted, over the still; disabled while it plays.
    private var liveButton: some View {
        let playing = playback.isPlayingLive
        return HStack {
            Button {
                playback.playLive()
            } label: {
                Label("LIVE", systemImage: "livephoto")
                    .font(.caption.weight(.semibold))
                    .padding(.horizontal, 10)
                    .padding(.vertical, 5)
                    .background(Capsule().fill(Color.black.opacity(playing ? 0.72 : 0.5)))
                    .foregroundStyle(playing ? Color.yellow : Color.white)
            }
            .buttonStyle(.plain)
            .disabled(playing)
            .accessibilityLabel("Play Live Photo")
            .accessibilityValue(playing ? "Playing" : "")
            Spacer()
        }
        .padding(.horizontal, 12)
        .padding(.top, 8)
    }

    @ViewBuilder
    private var chromeBackground: some View {
        if reduceTransparency {
            Color.black.opacity(0.94)
        } else {
            Rectangle().fill(.ultraThinMaterial)
        }
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
    @Environment(\.dismiss) private var dismiss

    init(photo: PhotoRecord, api: any PhotoBrainAPI, onSelect: ShowInLibraryAction?) {
        self.photo = photo
        self.onSelect = onSelect
        _tags = StateObject(wrappedValue: PhotoTagsStore(photoID: photo.id, api: api))
        _place = StateObject(wrappedValue: PhotoPlaceStore(photoID: photo.id, api: api))
        _pair = StateObject(wrappedValue: PhotoPairStore(photo: photo, api: api))
    }

    var body: some View {
        NavigationStack {
            List {
                Section {
                    HStack {
                        Spacer()
                        RemotePhotoImage(
                            photo: photo,
                            url: photo.thumbnailURL,
                            contentMode: .fit,
                            showsRetry: false,
                            targetSize: CGSize(width: 240, height: 180)
                        ) {
                            Color(uiColor: SyntheticThumbnail.color(id: photo.id))
                        }
                        .frame(width: 240, height: 180)
                        .clipShape(RoundedRectangle(cornerRadius: 12))
                        .accessibilityLabel("Thumbnail for \(photo.filename)")
                        Spacer()
                    }
                }
                Section("Tags") {
                    tagContent
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
            .navigationTitle(photo.isVideo ? "Video Info" : "Photo Info")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") { dismiss() }
                }
            }
        }
        .presentationDragIndicator(.visible)
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
            .padding(.horizontal, 12)
            .padding(.vertical, 6)
            .background(Capsule().fill(Color.accentColor.opacity(0.18)))
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
