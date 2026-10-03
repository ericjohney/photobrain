import SwiftUI

struct LoupeScreen: View {
    let records: [PhotoRecord]
    @Binding var activeID: Int
    let api: any PhotoBrainAPI
    let dismiss: () -> Void
    @Environment(\.accessibilityReduceTransparency) private var reduceTransparency
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    @State private var chromeVisible = true
    @State private var showingInfo = false
    @State private var similarSource: PhotoRecord?

    private var activeRecord: PhotoRecord? {
        records.first { $0.id == activeID }
    }

    var body: some View {
        ZStack {
            Color.black.ignoresSafeArea()
            PagedLoupe(
                records: records,
                activeID: $activeID,
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
                    Spacer()
                    filmstrip
                }
                .transition(.opacity)
            }
        }
        .preferredColorScheme(.dark)
        .statusBarHidden(!chromeVisible)
        .sheet(isPresented: $showingInfo) {
            if let activeRecord {
                PhotoMetadataView(photo: activeRecord)
            }
        }
        .sheet(item: $similarSource) { source in
            SimilarPhotosScreen(source: source, api: api) { similarSource = nil }
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

    @ViewBuilder
    private var chromeBackground: some View {
        if reduceTransparency {
            Color.black.opacity(0.94)
        } else {
            Rectangle().fill(.ultraThinMaterial)
        }
    }
}

private struct PhotoMetadataView: View {
    let photo: PhotoRecord
    @Environment(\.dismiss) private var dismiss

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
                Section("File") {
                    row("Name", photo.filename)
                    row("Size", photo.fileSize.map { ByteCountFormatter.string(fromByteCount: Int64($0), countStyle: .file) })
                    if photo.pixelWidth > 0, photo.pixelHeight > 0 {
                        row("Dimensions", "\(photo.pixelWidth) × \(photo.pixelHeight)")
                    }
                    row("Type", photo.mimeType)
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
                        row("Latitude", exif.gpsLatitude)
                        row("Longitude", exif.gpsLongitude)
                        row("Altitude", exif.gpsAltitude)
                    }
                }
            }
            .navigationTitle("Photo Info")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") { dismiss() }
                }
            }
        }
        .presentationDragIndicator(.visible)
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
