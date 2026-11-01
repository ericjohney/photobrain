import AVFoundation
import SwiftUI

struct LoupeScreen: View {
    let records: [LibraryEntry]
    @Binding var activeID: LibraryEntryID
    let api: any PhotoBrainAPI
    @ObservedObject var curation: PhotoCurationCenter
    let collections: CollectionsStore
    let dismiss: () -> Void
    /// Set when presented from Review: shows Reject/Keep instead of rating and flag controls.
    var review: LoupeReviewActions?
    /// The grid this loupe zooms out of and back into; nil falls back to the cover animation.
    var transition: LoupeZoomTransition?
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    @State private var chromeVisible = true
    @State private var isZoomed = false
    @State private var zoomControlsVisible = false
    @State private var showingInfo = false
    @State private var similarSource: PhotoRecord?
    @State private var collectionSheetPhotoID: CollectionSheetTarget?
    @StateObject private var exports: ExportStore
    /// The open page's video or Live Photo player; released on page change and dismissal.
    @StateObject private var playback = LoupePlaybackController()
    /// Show Faces: boxes over the paged photos while on.
    @StateObject private var faceBoxes: LoupeFaceBoxesStore
    /// Show Developed RAW: the open RAW fully developed instead of its embedded preview.
    @StateObject private var developed: LoupeDevelopedStore
    @StateObject private var rawEditor: LoupeRawEditStore
    @State private var rawControl: RawEditControl = .exposure
    @State private var confirmDiscardRawEdit = false
    @State private var rawControlsHeight: CGFloat = 240
    @Environment(\.scenePhase) private var scenePhase
    @Environment(\.showInLibrary) private var showInLibrary
    @State private var bridge = LoupePagerBridge()
    /// The image flying between the grid cell and the loupe; nil when settled.
    @State private var flight: LoupeFlight?
    @State private var backdropOpacity: Double = 1
    /// True while the pager is hidden behind a flight or dragged toward dismissal.
    @State private var transitioning = false
    @State private var dismissDragging = false
    @State private var didRunEntrance = false
    /// O(1) id lookup; the body reads the open record many times per scrub step.
    @State private var recordIndex = LoupeRecordIndex()
    /// Share sheet for a device-only photo's original from PhotoKit.
    @State private var deviceShare: DeviceShareItem?
    @Environment(\.backupCoordinator) private var backup

    /// Server photos (every screen but the Library): each is its own cell.
    init(
        records: [PhotoRecord],
        activeID: Binding<Int>,
        api: any PhotoBrainAPI,
        curation: PhotoCurationCenter,
        collections: CollectionsStore,
        dismiss: @escaping () -> Void,
        review: LoupeReviewActions? = nil,
        transition: LoupeZoomTransition? = nil
    ) {
        self.init(
            items: records.map(LibraryEntry.init(remote:)),
            activeID: Binding(
                get: { .remote(activeID.wrappedValue) },
                set: { if let id = $0.remotePhotoID { activeID.wrappedValue = id } }
            ),
            api: api,
            curation: curation,
            collections: collections,
            dismiss: dismiss,
            review: review,
            transition: transition
        )
    }

    init(
        items records: [LibraryEntry],
        activeID: Binding<LibraryEntryID>,
        api: any PhotoBrainAPI,
        curation: PhotoCurationCenter,
        collections: CollectionsStore,
        dismiss: @escaping () -> Void,
        review: LoupeReviewActions? = nil,
        transition: LoupeZoomTransition? = nil
    ) {
        self.records = records
        _activeID = activeID
        self.api = api
        self.curation = curation
        self.collections = collections
        self.dismiss = dismiss
        self.review = review
        self.transition = transition
        _exports = StateObject(wrappedValue: ExportStore(api: api))
        _faceBoxes = StateObject(wrappedValue: LoupeFaceBoxesStore(api: api))
        _developed = StateObject(wrappedValue: LoupeDevelopedStore(api: api))
        _rawEditor = StateObject(wrappedValue: LoupeRawEditStore(api: api))
    }

    private var activeItem: LibraryEntry? {
        recordIndex.index(of: activeID, in: records).map { records[$0] }
    }

    /// The open server photo; nil on a device-only page, which hides server features.
    private var activeRecord: PhotoRecord? {
        activeItem?.remote
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

    private var showsChrome: Bool {
        (rawEditor.isActive || (isZoomed ? zoomControlsVisible : chromeVisible)) && !transitioning && !dismissDragging
    }

    var body: some View {
        ZStack {
            Color.black.opacity(dismissDragging ? 0 : backdropOpacity).ignoresSafeArea()
            PagedLoupe(
                records: records,
                activeID: $activeID,
                playback: playback,
                chromeVisible: chromeVisible,
                onTap: { if !rawEditor.isActive { toggleChrome() } },
                onEmpty: dismiss,
                faceBoxes: faceBoxes.visibleBoxes,
                developedImages: rawEditor.isActive ? rawEditor.images : developed.images,
                rawEditingActive: rawEditor.isActive,
                onDismissDragActive: { active in
                    withAnimation(.easeOut(duration: 0.15)) { dismissDragging = active }
                },
                onDismissRequest: { frame, image, opacity in
                    close(from: frame, image: image, backdrop: opacity)
                },
                onSwipeUp: {
                    guard activeItem != nil else { return }
                    showingInfo = true
                },
                placeholder: { id in transition?.image(for: id) },
                bridge: bridge,
                infoVisible: showingInfo,
                onSwipeDownToCloseInfo: { showingInfo = false },
                onZoomChanged: { zoomed in
                    zoomControlsVisible = false
                    if reduceMotion {
                        isZoomed = zoomed
                    } else {
                        withAnimation(.easeInOut(duration: 0.18)) { isZoomed = zoomed }
                    }
                }
            )
            .padding(.bottom, rawEditor.isActive ? rawControlsHeight + PBSpacing.m : 0)
            .padding(.top, rawEditor.isActive ? PBSize.control + PBSpacing.m : 0)
            .ignoresSafeArea()
            .opacity(transitioning ? 0 : 1)

            if let flight {
                Color.clear
                    .ignoresSafeArea()
                    .overlay(alignment: .topLeading) {
                        Image(uiImage: flight.image)
                            .resizable()
                            .aspectRatio(contentMode: .fill)
                            .frame(width: flight.frame.width, height: flight.frame.height)
                            .clipped()
                            .opacity(flight.opacity)
                            .offset(x: flight.frame.minX, y: flight.frame.minY)
                            .ignoresSafeArea()
                    }
                    .allowsHitTesting(false)
                    .accessibilityHidden(true)
            }

            if showsChrome {
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
                    if !rawEditor.isActive { overlayControls }
                    Spacer()
                    if rawEditor.isActive {
                        rawEditControls
                    } else if !isZoomed {
                        filmstrip
                    }
                    if !rawEditor.isActive {
                        if let activeRecord {
                            if let review {
                                reviewBar(activeRecord, review: review)
                            } else {
                                curationBar(activeRecord)
                            }
                        } else if let activeItem, let local = activeItem.local {
                            deviceBar(activeItem, asset: local)
                        }
                    }
                }
                .padding(.bottom, PBSpacing.xs)
                .transition(.opacity)
            }
        }
        .preferredColorScheme(.dark)
        .presentationBackground(.clear)
        .onAppear {
            playback.show(item: activeItem)
            developed.show(activeRecord)
            runEntrance()
        }
        .onChange(of: activeID) { _, _ in
            rawEditor.end()
            playback.show(item: activeItem)
            Task { await faceBoxes.load(activeRecord) }
            developed.show(activeRecord)
        }
        .onDisappear {
            playback.release()
            developed.release()
            rawEditor.end()
        }
        .onChange(of: scenePhase) { _, phase in
            if phase == .background {
                developed.release()
            } else if phase == .active, !rawEditor.isActive {
                developed.show(activeRecord)
            }
        }
        .onReceive(NotificationCenter.default.publisher(for: UIApplication.didReceiveMemoryWarningNotification)) { _ in
            developed.release()
        }
        .confirmationDialog("Discard RAW adjustments?", isPresented: $confirmDiscardRawEdit, titleVisibility: .visible) {
            Button("Discard Changes", role: .destructive, action: endRawEdit)
            Button("Keep Editing", role: .cancel) { }
        } message: {
            Text("Your saved adjustments and original RAW will be kept.")
        }
        .statusBarHidden(!showsChrome)
        .exportPresentation(exports)
        .sheet(isPresented: $showingInfo) {
            if let activeRecord {
                PhotoMetadataView(photo: activeRecord, api: api, onSelect: librarySelection, curation: review == nil ? curation : nil)
                    .id(activeRecord.id)
            } else if let activeItem, let local = activeItem.local {
                DeviceAssetInfoView(item: activeItem, asset: local)
                    .id(activeItem.id)
            }
        }
        .sheet(item: $deviceShare) { share in
            DeviceShareSheet(assetID: share.assetID) { deviceShare = nil }
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
        .accessibilityAction(named: "Close photo") {
            close(from: nil, image: nil, backdrop: 1)
        }
        .accessibilityAction(named: showsChrome ? "Hide controls" : "Show controls", toggleChrome)
    }

    private func toggleChrome() {
        let toggle = {
            if isZoomed {
                zoomControlsVisible.toggle()
            } else {
                chromeVisible.toggle()
            }
        }
        if reduceMotion {
            toggle()
        } else {
            withAnimation(.easeInOut(duration: 0.18), toggle)
        }
    }

    /// Photos-style top bar: back, a centered place/date title, and More.
    @ViewBuilder
    private var topChrome: some View {
        if rawEditor.isActive {
            HStack {
                Button("Cancel", action: requestEndRawEdit)
                    .accessibilityIdentifier("raw-edit-close")
                Spacer()
                Text("Edit RAW").font(.headline).foregroundStyle(.white)
                Spacer()
                Button {
                    Task {
                        if await rawEditor.save() {
                            rawEditor.end()
                            developed.setOn(true, photo: activeRecord)
                        }
                    }
                } label: {
                    if rawEditor.isSaving { ProgressView().tint(.white) }
                    else { Text("Save").fontWeight(.semibold) }
                }
                .disabled(!rawEditor.isReady || rawEditor.isSaving)
                .accessibilityIdentifier("raw-edit-save")
            }
            .tint(.white)
            .padding(.horizontal, PBSpacing.l)
            .frame(minHeight: PBSize.control)
            .disabled(rawEditor.isSaving)
        } else {
            HStack(spacing: PBSpacing.m) {
                GlassIconButton(systemImage: "chevron.backward", accessibilityLabel: "Close photo", dark: true) {
                    close(from: nil, image: nil, backdrop: 1)
                }
                Spacer(minLength: 0)
                if let activeRecord {
                    LoupeTitle(photo: activeRecord, api: api, position: position)
                        .id(activeItem?.id)
                } else if let activeItem {
                    DeviceLoupeTitle(item: activeItem, position: position)
                }
                Spacer(minLength: 0)
                if review == nil, activeRecord != nil {
                    moreMenu
                } else {
                    infoButton
                }
            }
            .padding(.horizontal, PBSpacing.m)
            .padding(.top, PBSpacing.xs)
        }
    }

    private var infoButton: some View {
        GlassIconButton(systemImage: "info", accessibilityLabel: "Photo info", dark: true) {
            showingInfo = true
        }
        .disabled(activeItem == nil)
    }

    // MARK: Zoom transition

    /// Flies the grid cell's image to its fitted loupe frame, then reveals the pager.
    private func runEntrance() {
        guard !didRunEntrance else { return }
        didRunEntrance = true
        guard !reduceMotion,
              let transition,
              let image = transition.image(for: activeID),
              let from = transition.frame(for: activeID) else { return }
        let to = AVMakeRect(aspectRatio: image.size, insideRect: transition.containerBounds)
        transition.setHidden(activeID)
        flight = LoupeFlight(image: image, frame: from)
        transitioning = true
        backdropOpacity = 0
        withAnimation(.spring(duration: 0.38, bounce: 0.12)) {
            flight?.frame = to
            backdropOpacity = 1
        } completion: {
            transitioning = false
            flight = nil
            transition.setHidden(nil)
        }
    }

    /// Flies the open photo back into its grid cell (or off the bottom without a grid), then
    /// dismisses without the cover animation.
    private func close(from frame: CGRect?, image: UIImage?, backdrop: Double) {
        if rawEditor.isActive { requestEndRawEdit(); return }
        deviceShare = nil
        let current = bridge.controller?.activeImageFrame()
        guard !reduceMotion,
              let image = image ?? current?.1,
              let start = frame ?? current?.0 else {
            dismissDragging = false
            dismiss()
            return
        }
        let target = transition?.frame(for: activeID)
        let bounds = transition?.containerBounds ?? UIScreen.main.bounds
        transition?.setHidden(activeID)
        flight = LoupeFlight(image: image, frame: start)
        transitioning = true
        backdropOpacity = backdrop
        dismissDragging = false
        withAnimation(.spring(duration: 0.34, bounce: 0.06)) {
            if let target {
                flight?.frame = target
            } else {
                flight?.frame = start.offsetBy(dx: 0, dy: bounds.height * 0.4)
                flight?.opacity = 0
            }
            backdropOpacity = 0
        } completion: {
            transition?.setHidden(nil)
            LoupeZoomTransition.withoutAnimation { dismiss() }
        }
    }

    /// `(index, count)` of the open photo, for the title's accessibility value.
    private var position: (Int, Int) {
        ((recordIndex.index(of: activeID, in: records) ?? 0) + 1, records.count)
    }

    /// Share (export sizes) and everything else that acts on the open photo.
    private var moreMenu: some View {
        Menu {
            if let activeRecord {
                let current = PhotoCuration(activeRecord)
                Section {
                    Menu {
                        ForEach((0...5).reversed(), id: \.self) { stars in
                            Button {
                                curation.update(activeRecord, patch: CurationPatch(rating: stars))
                            } label: {
                                if current.rating == stars {
                                    Label(Self.ratingTitle(stars), systemImage: "checkmark")
                                } else {
                                    Text(Self.ratingTitle(stars))
                                }
                            }
                            .accessibilityLabel(stars == 0 ? "Clear rating" : stars == 1 ? "Rate 1 star" : "Rate \(stars) stars")
                        }
                    } label: {
                        Label(current.rating > 0 ? "Rating: \(Self.ratingTitle(current.rating))" : "Rating", systemImage: "star")
                    }
                }
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
                    if LoupeRendition.developableRawID(for: activeRecord) != nil {
                        Button {
                            if rawEditor.isActive {
                                endRawEdit()
                            } else {
                                developed.release()
                                rawControl = .exposure
                                rawEditor.start(activeRecord)
                                chromeVisible = true
                                zoomControlsVisible = true
                            }
                        } label: {
                            Label(rawEditor.isActive ? "Close RAW Editor" : "Edit RAW", systemImage: "slider.horizontal.3")
                        }
                        Button {
                            developed.setOn(!developed.isOn, photo: activeRecord)
                        } label: {
                            Label(
                                developed.isOn ? "Show Embedded Preview" : "Show Developed RAW",
                                systemImage: "camera.aperture"
                            )
                        }
                        .disabled(rawEditor.isActive)
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

    static func ratingTitle(_ stars: Int) -> String {
        stars == 0 ? "None" : String(repeating: "★", count: stars)
    }

    private var shareMenu: some View {
        Menu {
            if let activeRecord {
                if let rawID = LoupeRendition.developableRawID(for: activeRecord) {
                    Button {
                        exports.start(.developed(id: rawID))
                    } label: {
                        Label("Share Developed Photo", systemImage: "camera.aperture")
                    }
                }
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

    /// Photos-style bottom bar: Share, Favorite (Pick), Info, and Reject (in place of Delete).
    private func curationBar(_ photo: PhotoRecord) -> some View {
        let current = PhotoCuration(photo)
        let picked = current.flag == .pick
        let rejected = current.flag == .reject
        return HStack {
            shareMenu
            Spacer(minLength: 0)
            Button {
                curation.update(photo, patch: .toggledFlag(.pick, current: current))
            } label: {
                GlassIconLabel(systemImage: picked ? "heart.fill" : "heart", dark: true, tint: picked ? .pink : nil)
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Pick")
            .accessibilityAddTraits(picked ? .isSelected : [])
            Spacer(minLength: 0)
            infoButton
            Spacer(minLength: 0)
            Button {
                curation.update(photo, patch: .toggledFlag(.reject, current: current))
            } label: {
                GlassIconLabel(systemImage: rejected ? "xmark.bin.fill" : "xmark.bin", dark: true, tint: rejected ? PBColor.reject : nil)
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Reject")
            .accessibilityAddTraits(rejected ? .isSelected : [])
        }
        .padding(.horizontal, PBSpacing.l)
    }

    /// A device-only photo: Share (its original), its backup state, Info, and Back Up Now.
    /// Rating, Pick/Reject, collections, and the other server features arrive once the photo
    /// is backed up and imported.
    private func deviceBar(_ item: LibraryEntry, asset: LocalAsset) -> some View {
        let state = item.backupState ?? .notBackedUp
        return HStack {
            Button {
                deviceShare = DeviceShareItem(assetID: asset.id)
            } label: {
                GlassIconLabel(systemImage: "square.and.arrow.up", dark: true)
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Share")
            Spacer(minLength: 0)
            Menu {
                Section(state.title) {
                    Button {
                        backup?.backUpNow()
                    } label: {
                        Label("Back Up Now", systemImage: "icloud.and.arrow.up")
                    }
                    .disabled(backup?.settings.enabled != true)
                }
                if backup?.settings.enabled != true {
                    Section {
                        Text("Turn on Backup in Settings to rate, pick, and organize this photo.")
                    }
                }
            } label: {
                Label(state.title, systemImage: state.systemImage)
                    .font(.caption.weight(.semibold))
                    .padding(.horizontal, 12)
                    .frame(height: PBSize.control)
                    .foregroundStyle(state == .failed ? Color.yellow : Color.white)
                    .pbGlass(in: Capsule(), interactive: true, dark: true)
            }
            .accessibilityLabel("Backup")
            .accessibilityValue(state.accessibilityText)
            .accessibilityHint("Rating and organizing are available once this photo is backed up")
            Spacer(minLength: 0)
            infoButton
        }
        .padding(.horizontal, PBSpacing.l)
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
    /// Dragging it scrubs through the photos.
    private var filmstrip: some View {
        LoupeFilmstrip(
            records: records,
            activeID: activeID,
            height: dynamicTypeSize.isAccessibilitySize ? 56 : 40,
            reduceMotion: reduceMotion
        ) { id in
            activeID = id
        }
    }

    /// LIVE (for Live Photos), Show Faces (for stills), and the RAW rendition badge over the
    /// top of the photo.
    @ViewBuilder
    private var overlayControls: some View {
        let hasLive = activeRecord?.motionVideoURL != nil
        let canShowFaces = faceBoxes.isShowing && (activeRecord.map { !$0.isVideo } ?? false)
        let showsRendition = LoupeRendition.developableRawID(for: activeRecord) != nil
        if hasLive || canShowFaces || showsRendition {
            HStack(spacing: 8) {
                if hasLive { liveButton }
                if canShowFaces { facesButton }
                Spacer()
                if showsRendition { renditionBadge }
            }
            .padding(.horizontal, PBSpacing.m)
        }
    }

    /// Which rendition of the RAW is on screen: tap to switch.
    private var renditionBadge: some View {
        let rendition = developed.isOn ? developed.rendition : .embedded
        let label = rawEditor.isActive ? rawEditor.label : rendition.label
        return Button {
            developed.setOn(!developed.isOn, photo: activeRecord)
        } label: {
            HStack(spacing: 6) {
                if rendition == .developing {
                    ProgressView().controlSize(.mini).tint(.white)
                }
                Text(label)
                    .monospacedDigit()
                    .lineLimit(1)
            }
            .font(.caption.weight(.semibold))
            .padding(.horizontal, 12)
            .padding(.vertical, 7)
            .foregroundStyle({
                if case .developed = rendition { return Color.yellow }
                return Color.white
            }())
            .pbGlass(in: Capsule(), interactive: true, dark: true)
        }
        .buttonStyle(.plain)
        .disabled(rawEditor.isActive)
        .accessibilityIdentifier("loupe-rendition")
        .accessibilityLabel(label)
        .accessibilityHint(developed.isOn ? "Shows the embedded preview" : "Develops the full RAW")
    }

    private func endRawEdit() {
        guard rawEditor.isActive else { return }
        rawEditor.end()
        developed.show(activeRecord)
    }

    private func requestEndRawEdit() {
        guard !rawEditor.isSaving else { return }
        if rawEditor.hasChanges { confirmDiscardRawEdit = true }
        else { endRawEdit() }
    }

    private var rawEditControls: some View {
        VStack(alignment: .leading, spacing: 12) {
            switch rawEditor.phase {
            case .loading:
                HStack {
                    ProgressView().tint(.white)
                    Text(rawEditor.label).font(.subheadline)
                }
                .accessibilityIdentifier("raw-edit-loading")
            case .ready:
                HStack {
                    Button {
                        rawEditor.toggleBefore()
                    } label: {
                        Label(rawEditor.showingBefore ? "Before" : "Before / After", systemImage: "square.lefthalf.filled")
                    }
                    .accessibilityIdentifier("raw-edit-compare")
                    .accessibilityValue(rawEditor.showingBefore ? "Before adjustments" : "After adjustments")
                    Spacer()
                    if rawEditor.isRendering { ProgressView().controlSize(.small).tint(.white) }
                    Button("Reset") { rawEditor.reset() }
                        .disabled(rawEditor.settings == RawEditSettings())
                        .accessibilityIdentifier("raw-edit-reset")
                }
                .font(.subheadline.weight(.medium))
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: 8) {
                        ForEach(rawEditor.controls) { control in
                            Button {
                                rawControl = control
                            } label: {
                                Label(control.title, systemImage: control.symbol)
                                    .font(.caption.weight(.semibold))
                                    .padding(.horizontal, 12)
                                    .frame(minHeight: PBSize.control)
                                    .background(Capsule().fill(rawControl == control ? Color.white.opacity(0.22) : Color.clear))
                            }
                            .accessibilityAddTraits(rawControl == control ? .isSelected : [])
                        }
                    }
                }
                HStack {
                    Text(rawControl.title).font(.subheadline)
                    Spacer()
                    Text(rawControl.label(in: rawEditor.settings)).monospacedDigit()
                        .accessibilityIdentifier("raw-edit-value")
                }
                Slider(
                    value: Binding(get: { rawControl.value(in: rawEditor.settings) }, set: { rawEditor.set(rawControl, value: $0) }),
                    in: rawControl.range, step: rawControl.step,
                    onEditingChanged: { rawEditor.setDragging($0) }
                )
                .accessibilityLabel("RAW \(rawControl.rawValue)")
                .accessibilityValue(rawControl.label(in: rawEditor.settings))
                .accessibilityIdentifier("raw-edit-\(rawControl.rawValue)")
                Text(rawEditor.supportsTone ? "Save adjustments · Original RAW is preserved" : "Exposure adjustments · Original RAW is preserved")
                    .font(.caption).foregroundStyle(.white.opacity(0.7))
                if let error = rawEditor.errorMessage {
                    Text(error).font(.caption).foregroundStyle(.yellow)
                        .accessibilityIdentifier("raw-edit-error")
                    Button("Retry Preview") { rawEditor.retryPreview() }
                }
            case let .failed(message):
                Text(message).font(.subheadline).foregroundStyle(.white.opacity(0.7))
                    .accessibilityIdentifier("raw-edit-error")
                Button("Try Again") {
                    if let activeRecord { rawEditor.start(activeRecord) }
                }
            case .inactive: EmptyView()
            }
        }
        .background {
            GeometryReader { geometry in
                Color.clear.preference(key: RawEditControlsHeight.self, value: geometry.size.height)
            }
        }
        .onPreferenceChange(RawEditControlsHeight.self) { rawControlsHeight = $0 }
        .disabled(rawEditor.isSaving)
        .foregroundStyle(.white)
        .tint(.white)
        .padding(PBSpacing.m)
        .frame(maxWidth: 600)
        .pbGlass(in: RoundedRectangle(cornerRadius: 20), dark: true)
        .padding(.horizontal, PBSpacing.m)
        .environment(\.colorScheme, .dark)
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

/// Five tappable stars; tapping the current rating clears it.
private struct InfoRatingRow: View {
    let photo: PhotoRecord
    @ObservedObject var curation: PhotoCurationCenter

    var body: some View {
        let current = PhotoCuration(curation.overlay([photo]).first ?? photo)
        HStack {
            Text("Rating")
            Spacer()
            HStack(spacing: 2) {
                ForEach(1...5, id: \.self) { stars in
                    Button {
                        curation.update(photo, patch: .toggledRating(stars, current: current))
                    } label: {
                        Image(systemName: stars <= current.rating ? "star.fill" : "star")
                            .foregroundStyle(stars <= current.rating ? PBColor.rating : Color.secondary)
                            .frame(width: 32, height: 32)
                            .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel(stars == 1 ? "Rate 1 star" : "Rate \(stars) stars")
                    .accessibilityAddTraits(current.rating == stars ? .isSelected : [])
                }
            }
        }
    }
}

private struct LoupeFlight {
    let image: UIImage
    var frame: CGRect
    var opacity: Double = 1
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
    /// Rates the photo from the sheet; nil (Review) hides the rating row.
    let curation: PhotoCurationCenter?

    init(photo: PhotoRecord, api: any PhotoBrainAPI, onSelect: ShowInLibraryAction?, curation: PhotoCurationCenter? = nil) {
        self.photo = photo
        self.onSelect = onSelect
        self.curation = curation
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
                    if let curation {
                        InfoRatingRow(photo: photo, curation: curation)
                    }
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
            if photo.rating > 0 {
                Text(String(repeating: "★", count: photo.rating))
                    .font(.caption2)
                    .foregroundStyle(PBColor.rating)
                    .accessibilityLabel(photo.rating == 1 ? "1 star" : "\(photo.rating) stars")
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
            // Scrubbing replaces this title per photo passed; only a photo that stays open
            // long enough loads its place.
            try? await Task.sleep(for: .milliseconds(200))
            guard !Task.isCancelled else { return }
            await place.load()
        }
    }
}

/// Maps item ids to positions in the loupe's records, rebuilt only when the array changes.
@MainActor
final class LoupeRecordIndex {
    private var items: [LibraryEntry] = []
    private var positions: [LibraryEntryID: Int] = [:]

    func index(of id: LibraryEntryID, in next: [LibraryEntry]) -> Int? {
        if !next.sharesStorage(with: items) {
            items = next
            positions = Dictionary(next.enumerated().map { ($1.id, $0) }, uniquingKeysWith: { first, _ in first })
        }
        return positions[id]
    }

    /// Server-record convenience.
    func index(of id: Int, in next: [PhotoRecord]) -> Int? {
        next.firstIndex { $0.id == id }
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

private struct DeviceShareItem: Identifiable {
    let assetID: String
    var id: String { assetID }
}

/// Title for a device-only photo: its date and time.
private struct DeviceLoupeTitle: View {
    let item: LibraryEntry
    let position: (Int, Int)

    var body: some View {
        let date = item.captureDate
        let zone = PhotoDateResolver.calendar.timeZone
        VStack(spacing: 0) {
            Text(date.formatted(Date.FormatStyle(timeZone: zone).month(.abbreviated).day().year()))
                .font(.subheadline.weight(.semibold))
            Text(date.formatted(Date.FormatStyle(timeZone: zone).hour().minute()))
                .font(.caption2)
                .foregroundStyle(.white.opacity(0.75))
        }
        .lineLimit(1)
        .minimumScaleFactor(0.8)
        .foregroundStyle(.white)
        .padding(.horizontal, PBSpacing.l)
        .frame(minHeight: PBSize.control)
        .pbGlass(in: Capsule(), dark: true)
        .accessibilityElement(children: .combine)
        .accessibilityValue("Photo \(position.0) of \(position.1)")
    }
}

/// Info for a device-only photo: what PhotoKit knows, plus its backup state.
private struct DeviceAssetInfoView: View {
    let item: LibraryEntry
    let asset: LocalAsset
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            List {
                Section {
                    LabeledContent("Taken") {
                        Text(item.captureDate.formatted(Date.FormatStyle(
                            date: .long,
                            time: .shortened,
                            timeZone: PhotoDateResolver.calendar.timeZone
                        )))
                    }
                    if asset.pixelWidth > 0, asset.pixelHeight > 0 {
                        LabeledContent("Dimensions", value: "\(asset.pixelWidth) × \(asset.pixelHeight)")
                    }
                    if asset.isVideo {
                        LabeledContent("Duration", value: VideoDuration.text(milliseconds: asset.durationMs))
                    }
                }
                Section("Backup") {
                    let state = item.backupState ?? .notBackedUp
                    Label(state.title, systemImage: state.systemImage)
                    Text("Tags, places, people, ratings, and collections appear once this photo is backed up and imported.")
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                }
                if let coordinate = asset.coordinate {
                    Section("Location") {
                        PhotoLocationMiniMap(coordinate: coordinate)
                        LabeledContent("Coordinates", value: coordinate.formatted)
                    }
                }
            }
            .navigationTitle(asset.isVideo ? "Video Info" : "Photo Info")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") { dismiss() }
                }
            }
        }
        .presentationDetents([.medium, .large])
        .presentationDragIndicator(.visible)
    }
}

/// Shares a device photo's original: exported from PhotoKit into a temporary directory that
/// is deleted when the sheet closes.
private struct DeviceShareSheet: View {
    let assetID: String
    let onFinish: () -> Void
    @State private var file: URL?
    @State private var failed = false

    var body: some View {
        Group {
            if let file {
                ActivityView(items: [file]) {
                    try? FileManager.default.removeItem(at: file.deletingLastPathComponent())
                    onFinish()
                }
                .ignoresSafeArea()
            } else if failed {
                ContentUnavailableView(
                    "Couldn’t Share",
                    systemImage: "exclamationmark.triangle",
                    description: Text("The original isn’t available on this iPhone.")
                )
            } else {
                ProgressView("Preparing…")
            }
        }
        .presentationDetents([.medium, .large])
        .task {
            do {
                file = try await DeviceOriginalExporter.export(assetID: assetID)
            } catch {
                failed = true
            }
        }
    }
}

private struct ActivityView: UIViewControllerRepresentable {
    let items: [Any]
    let onComplete: () -> Void

    func makeUIViewController(context: Context) -> UIActivityViewController {
        let controller = UIActivityViewController(activityItems: items, applicationActivities: nil)
        controller.completionWithItemsHandler = { _, _, _, _ in onComplete() }
        return controller
    }

    func updateUIViewController(_ controller: UIActivityViewController, context: Context) {}
}

private struct RawEditControlsHeight: PreferenceKey {
    static let defaultValue: CGFloat = 240
    static func reduce(value: inout CGFloat, nextValue: () -> CGFloat) { value = nextValue() }
}
