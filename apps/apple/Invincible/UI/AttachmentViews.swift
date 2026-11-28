import Observation
import PhotosUI
import SwiftUI
import UniformTypeIdentifiers

/// What each picture of yours looks like, by its id: those sent from here are known already; another is asked of the
/// node once (`POST /api/uploads/get`). Kept while the app runs, never on disk.
@MainActor @Observable final class AttachmentLooks {
    static let shared = AttachmentLooks()

    private var known: [String: Data] = [:]
    private var asking: Set<String> = []

    func know(_ id: String, _ data: Data) {
        known[id] = data
    }

    func data(_ id: String) -> Data? {
        known[id]
    }

    /// Asks the node for a picture's bytes, once; what is there afterwards is `data(_:)`.
    func load(_ ref: AttachmentRef, with client: NodeClient) async {
        guard ref.isPicture, known[ref.id] == nil, !asking.contains(ref.id) else { return }
        asking.insert(ref.id)
        defer { asking.remove(ref.id) }
        struct Asked: Encodable { let id: String }
        if let data = try? await client.bytes("/api/uploads/get", Asked(id: ref.id)) { known[ref.id] = data }
    }
}

/// What a message of yours carried: its pictures (each opened large with a tap) and its texts, by name and size.
struct AttachedView: View {
    let refs: [AttachmentRef]
    let client: NodeClient?
    @State private var opened: AttachmentRef?

    var body: some View {
        let looks = AttachmentLooks.shared
        HStack(spacing: Space.s2) {
            Spacer(minLength: 0)
            ForEach(refs, id: \.id) { ref in
                if ref.isPicture {
                    Button {
                        opened = ref
                    } label: {
                        Group {
                            if let data = looks.data(ref.id), let image = PlatformImage(data: data) {
                                Image(platformImage: image).resizable().scaledToFill()
                            } else {
                                Rectangle().fill(.fill.tertiary).overlay { ProgressView().controlSize(.small) }
                            }
                        }
                        .frame(width: 132, height: 132)
                        .clipShape(.rect(cornerRadius: Metrics.cardRadius, style: .continuous))
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel("Open \(ref.name)")
                    .task { if let client { await looks.load(ref, with: client) } }
                } else {
                    FileChip(name: ref.name, said: Self.size(ref.bytes))
                }
            }
        }
        .cover(isPresented: .init(get: { opened != nil }, set: { if !$0 { opened = nil } })) {
            if let opened { PictureViewer(pictures: refs.filter(\.isPicture), shown: opened.id, client: client) }
        }
    }

    /// A size as the app says one: bytes, KB or MB.
    static func size(_ bytes: Int) -> String {
        ByteCountFormatter.string(fromByteCount: Int64(bytes), countStyle: .file)
    }
}

extension AttachmentRef: Identifiable {}

/// A message's pictures, large: swiped between (on a Mac, the arrows), pinched or double-tapped to look closer, and shared.
struct PictureViewer: View {
    let pictures: [AttachmentRef]
    @State var shown: String
    let client: NodeClient?
    @Environment(\.dismiss) private var dismiss

    private var current: AttachmentRef? { pictures.first { $0.id == shown } }
    private var at: Int { pictures.firstIndex { $0.id == shown } ?? 0 }

    var body: some View {
        NavigationStack {
            Group {
                #if os(iOS)
                TabView(selection: $shown) {
                    ForEach(pictures, id: \.id) { ref in ZoomablePicture(ref: ref, client: client).tag(ref.id) }
                }
                .tabViewStyle(.page(indexDisplayMode: pictures.count > 1 ? .automatic : .never))
                #else
                if let current { ZoomablePicture(ref: current, client: client).id(current.id) }
                #endif
            }
            .background(Color.black)
            .navigationTitle(current?.name ?? "Picture")
            .inlineTitle()
            .toolbar {
                ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } }
                #if os(macOS)
                if pictures.count > 1 {
                    ToolbarItemGroup(placement: .navigation) {
                        Button { shown = pictures[at - 1].id } label: { Label("Previous", systemImage: "chevron.left") }.disabled(at == 0)
                        Button { shown = pictures[at + 1].id } label: { Label("Next", systemImage: "chevron.right") }.disabled(at == pictures.count - 1)
                    }
                }
                #endif
                if let current, let data = AttachmentLooks.shared.data(current.id), let image = PlatformImage(data: data) {
                    ToolbarItem(placement: .primaryAction) {
                        ShareLink(item: Image(platformImage: image), preview: SharePreview(current.name, image: Image(platformImage: image))) {
                            Label("Share", systemImage: "square.and.arrow.up")
                        }
                    }
                }
            }
        }
        // On black, as a photo is shown: its title and buttons light.
        .preferredColorScheme(.dark)
        #if os(macOS)
        .frame(minWidth: 640, minHeight: 480)
        #endif
    }
}

/// One picture, fitted to the screen: a pinch (or a double tap) looks closer, and a drag moves about it while it's close.
private struct ZoomablePicture: View {
    let ref: AttachmentRef
    let client: NodeClient?
    @State private var scale: CGFloat = 1
    @State private var settled: CGFloat = 1
    @State private var offset: CGSize = .zero
    @State private var dragged: CGSize = .zero

    var body: some View {
        let looks = AttachmentLooks.shared
        Group {
            if let data = looks.data(ref.id), let image = PlatformImage(data: data) {
                Image(platformImage: image)
                    .resizable()
                    .scaledToFit()
                    .scaleEffect(scale)
                    .offset(offset)
                    .gesture(
                        MagnifyGesture()
                            .onChanged { scale = max(1, min(6, settled * $0.magnification)) }
                            .onEnded { _ in
                                settled = scale
                                if scale == 1 { (offset, dragged) = (.zero, .zero) }
                            }
                    )
                    // (Only while it's close: at its own size a drag swipes to the next picture.)
                    .gesture(
                        DragGesture()
                            .onChanged { offset = CGSize(width: dragged.width + $0.translation.width, height: dragged.height + $0.translation.height) }
                            .onEnded { _ in dragged = offset },
                        isEnabled: scale > 1
                    )
                    .onTapGesture(count: 2) {
                        if scale > 1 {
                            (scale, settled, offset, dragged) = (1, 1, .zero, .zero)
                        } else {
                            (scale, settled) = (2.5, 2.5)
                        }
                    }
                    .accessibilityLabel(ref.name)
                    .accessibilityAddTraits(.isImage)
            } else {
                ProgressView().tint(.white)
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .task { if let client { await looks.load(ref, with: client) } }
    }
}

/// A text file, by its name and what is said of it (its size, or that it is going up).
struct FileChip: View {
    let name: String
    let said: String
    var failed = false

    var body: some View {
        HStack(spacing: Space.s2) {
            Image(systemName: failed ? "exclamationmark.triangle" : "doc.text").foregroundStyle(failed ? Color.danger : .secondary)
            VStack(alignment: .leading, spacing: 0) {
                Text(name).font(.callout).lineLimit(1)
                Text(said).font(.caption).foregroundStyle(failed ? Color.danger : .secondary).lineLimit(1)
            }
        }
        .padding(.horizontal, Space.s3)
        .padding(.vertical, Space.s2)
        .background(.fill.tertiary, in: .rect(cornerRadius: Metrics.innerRadius, style: .continuous))
        .accessibilityElement(children: .combine)
    }
}

/// Your next message's files, above its words: each as it looks (a picture) or by name, going up or up, to remove.
struct WaitingFiles: View {
    let outbox: Outbox

    var body: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: Space.s2) {
                ForEach(outbox.waiting) { file in
                    HStack(spacing: Space.s2) {
                        ZStack {
                            if let data = file.look, let image = PlatformImage(data: data) {
                                Image(platformImage: image).resizable().scaledToFill().frame(width: 36, height: 36).clipShape(.rect(cornerRadius: 7, style: .continuous))
                            } else {
                                Image(systemName: failed(file) == nil ? "doc.text" : "exclamationmark.triangle").frame(width: 36, height: 36).foregroundStyle(.secondary)
                            }
                            if file.state == .going { ProgressView().controlSize(.small) }
                        }
                        VStack(alignment: .leading, spacing: 0) {
                            Text(file.name).font(.callout).lineLimit(1)
                            Text(failed(file) ?? (file.state == .going ? "Sending…" : AttachedView.size(file.size)))
                                .font(.caption)
                                .foregroundStyle(failed(file) == nil ? AnyShapeStyle(.secondary) : AnyShapeStyle(Color.danger))
                                .lineLimit(1)
                        }
                        .frame(maxWidth: 140, alignment: .leading)
                        Button {
                            outbox.detach(file.id)
                        } label: {
                            Image(systemName: "xmark").font(.caption.weight(.semibold)).frame(width: 24, height: 24)
                        }
                        .buttonStyle(.plain)
                        .foregroundStyle(.secondary)
                        .accessibilityLabel("Remove \(file.name)")
                    }
                    .padding(Space.s1)
                    .padding(.trailing, Space.s1)
                    .background(.fill.tertiary, in: .rect(cornerRadius: Metrics.innerRadius, style: .continuous))
                    .accessibilityElement(children: .contain)
                }
            }
        }
        .accessibilityLabel("Files with your message")
    }

    private func failed(_ file: Outbox.Waiting) -> String? {
        if case .failed(let why) = file.state { why } else { nil }
    }
}

/// Above a message box: why a file you added wasn't taken (for a moment), and the files waiting to go.
struct OutboxLines: View {
    @Bindable var outbox: Outbox

    var body: some View {
        if let problem = outbox.problem {
            Label(problem, systemImage: "exclamationmark.triangle.fill")
                .font(.caption)
                .foregroundStyle(Color.danger)
                .onTapGesture { outbox.problem = nil }
                .task(id: problem) {
                    try? await Task.sleep(for: .seconds(6))
                    if outbox.problem == problem { outbox.problem = nil }
                }
        }
        if !outbox.waiting.isEmpty { WaitingFiles(outbox: outbox) }
    }
}

extension View {
    /// Files dropped on a message box go with the message (Files, the Finder, another app's file); on a Mac, pasted
    /// ones too (⌘V: files copied in the Finder, or a picture copied alone).
    func takingFiles(_ outbox: Outbox, client: NodeClient, composing: FocusState<Bool>.Binding) -> some View {
        dropDestination(for: URL.self) { urls, _ in
            let files = AttachButton.read(urls.filter(\.isFileURL), refused: { outbox.problem = $0 })
            outbox.attach(files, with: client)
            return !files.isEmpty
        }
        #if os(macOS)
        .modifier(PasteFiles(outbox: outbox, client: client, composing: composing))
        #endif
    }
}

/// Files for your next message: a photo from Photos (or, on an iPhone or iPad, one taken now, or a picture you copied),
/// or a file (a picture, a PDF, or text) from Files.
struct AttachButton: View {
    let outbox: Outbox
    let client: NodeClient
    /// Giving its agent a task, first in the menu (an agent's chat).
    var give: (() -> Void)? = nil
    @State private var photos: [PhotosPickerItem] = []
    @State private var choosingPhotos = false
    @State private var choosingFiles = false
    #if os(iOS)
    @State private var takingPhoto = false
    #endif

    /// Its sign: + beside an iPhone's and an iPad's pill (Grok Bot's), a paperclip in a Mac's box.
    #if os(iOS)
    static let glyph = "plus"
    #else
    static let glyph = "paperclip"
    #endif

    /// What Files offers: pictures, PDFs, and the kinds of text one attaches (logs, notes, code, data).
    static let kinds: [UTType] = [.image, .pdf, .text, .plainText, .sourceCode, .json, .xml, .yaml, .commaSeparatedText, .log]

    var body: some View {
        Menu {
            if let give {
                Button(action: give) { Label("Give a task…", systemImage: "square.stack.3d.up") }
                    .accessibilityIdentifier("composer.give")
                Divider()
            }
            Button { choosingFiles = true } label: { Label("Files", systemImage: "folder") }
            #if os(iOS)
            if CameraPicker.available {
                Button { takingPhoto = true } label: { Label("Take Photo", systemImage: "camera") }
            }
            #endif
            Button { choosingPhotos = true } label: { Label("Photos", systemImage: "photo.on.rectangle") }
            #if os(iOS)
            // A picture you copied (iOS asks you once whether the app may read it).
            if UIPasteboard.general.hasImages {
                Button { Pasted.pictures(to: outbox, with: client) } label: { Label("Paste Picture", systemImage: "doc.on.clipboard") }
            }
            #endif
        } label: {
            // Beside the message box (ComposerBox), on the disc it gives it: a thumb's target (a Mac's, in its box).
            Image(systemName: Self.glyph).font(.body.weight(.semibold)).frame(minWidth: Metrics.touch, minHeight: Metrics.touch).contentShape(.circle)
        }
        .menuIndicator(.hidden)
        .buttonStyle(.borderless)
        .disabled(outbox.full)
        .accessibilityLabel(give == nil ? "Attach pictures or files" : "Give a task, or attach pictures or files")
        .accessibilityIdentifier("attach")
        // Each chooser hangs on a view of its own, never on the menu: one presentation per view, each free to show.
        .background { Color.clear.photosPicker(isPresented: $choosingPhotos, selection: $photos, maxSelectionCount: max(1, Attachments.perMessage - outbox.waiting.count), matching: .images) }
        .onChange(of: photos) { _, chosen in
            guard !chosen.isEmpty else { return }
            photos = []
            Task {
                var files: [(name: String, data: Data)] = []
                for (n, item) in chosen.enumerated() {
                    if let data = try? await item.loadTransferable(type: Data.self) { files.append((name: chosen.count == 1 ? "Photo" : "Photo \(n + 1)", data: data)) }
                }
                outbox.attach(files, with: client)
            }
        }
        .background {
            Color.clear.fileImporter(isPresented: $choosingFiles, allowedContentTypes: Self.kinds, allowsMultipleSelection: true) { result in
                guard case .success(let urls) = result else { return }
                outbox.attach(Self.read(urls, refused: { outbox.problem = $0 }), with: client)
            }
        }
        #if os(iOS)
        .background {
            Color.clear.fullScreenCover(isPresented: $takingPhoto) {
                CameraPicker { jpeg in outbox.attach([(name: "Photo", data: jpeg)], with: client) }
                    .ignoresSafeArea()
            }
        }
        #endif
    }

    /// The most a file may be to be read at all: a photo that large is still drawn again small enough to go.
    static let readLimit = 64 * 1024 * 1024

    /// Files from Files (or dropped), read whole while this app may; one past `readLimit`, or unreadable, is said so.
    static func read(_ urls: [URL], refused: (String) -> Void) -> [(name: String, data: Data)] {
        urls.compactMap { url in
            let scoped = url.startAccessingSecurityScopedResource()
            defer { if scoped { url.stopAccessingSecurityScopedResource() } }
            if let size = try? url.resourceValues(forKeys: [.fileSizeKey]).fileSize, size > readLimit {
                refused("\(url.lastPathComponent) is too big to go with a message.")
                return nil
            }
            guard let data = try? Data(contentsOf: url) else {
                refused("\(url.lastPathComponent) couldn't be read.")
                return nil
            }
            return (name: url.lastPathComponent, data: data)
        }
    }
}

#if os(macOS)
import AppKit

/// What a paste in the message box sends with the message, as the PWA takes a paste: files copied in the Finder (read
/// whole, as dropped ones are), or a picture copied alone (a screenshot), as a PNG. Nil when there is neither, or when
/// the picture comes with text (a page copied): that is pasted as its text.
@MainActor enum Pasted {
    /// The pasteboard ⌘V reads: the general one (a test sets one of its own, so your clipboard is never touched).
    static var board = NSPasteboard.general

    static func files(from board: NSPasteboard, refused: (String) -> Void) -> [(name: String, data: Data)]? {
        if let urls = board.readObjects(forClasses: [NSURL.self], options: [.urlReadingFileURLsOnly: true]) as? [URL], !urls.isEmpty {
            return AttachButton.read(urls, refused: refused)
        }
        guard board.string(forType: .string) == nil else { return nil }
        if let png = board.data(forType: .png) { return [(name: "Pasted picture.png", data: png)] }
        if let tiff = board.data(forType: .tiff), let png = NSBitmapImageRep(data: tiff)?.representation(using: .png, properties: [:]) {
            return [(name: "Pasted picture.png", data: png)]
        }
        return nil
    }
}

/// ⌘V in the message box with files or a picture to paste (`Pasted`): they go with the message. The field's own editor
/// takes ⌘V before SwiftUI sees it, and pastes nothing for a picture, so the keys are watched for while the box has them.
struct PasteFiles: ViewModifier {
    let outbox: Outbox
    let client: NodeClient
    let composing: FocusState<Bool>.Binding
    @State private var monitor: Any?

    func body(content: Content) -> some View {
        content
            .onAppear {
                guard monitor == nil else { return }
                monitor = NSEvent.addLocalMonitorForEvents(matching: .keyDown) { event in
                    guard event.modifierFlags.intersection(.deviceIndependentFlagsMask) == .command, event.charactersIgnoringModifiers == "v" else { return event }
                    let taken = MainActor.assumeIsolated { () -> Bool in
                        guard composing.wrappedValue, let files = Pasted.files(from: Pasted.board, refused: { outbox.problem = $0 }), !files.isEmpty else { return false }
                        outbox.attach(files, with: client)
                        return true
                    }
                    return taken ? nil : event
                }
            }
            .onDisappear {
                if let monitor { NSEvent.removeMonitor(monitor) }
                monitor = nil
            }
    }
}
#endif


#if os(iOS)
import UIKit

/// The pictures you copied, read when you ask for them (whether one is there is known without reading it), each as its
/// bytes (a picture of another kind, a HEIC, is drawn again as any other is).
@MainActor enum Pasted {
    static func pictures(to outbox: Outbox, with client: NodeClient) {
        let images = UIPasteboard.general.images ?? []
        let files = images.enumerated().compactMap { n, image in
            image.pngData().map { (name: images.count == 1 ? "Pasted picture.png" : "Pasted picture \(n + 1).png", data: $0) }
        }
        outbox.attach(files, with: client)
    }
}

/// The camera, for a photo taken now for your message: handed over as a JPEG, which is drawn again (smaller, and with
/// none of the photo's own metadata) as any other picture is before it goes.
struct CameraPicker: UIViewControllerRepresentable {
    static var available: Bool { UIImagePickerController.isSourceTypeAvailable(.camera) }

    let taken: (Data) -> Void
    @Environment(\.dismiss) private var dismiss

    func makeUIViewController(context: Context) -> UIImagePickerController {
        let picker = UIImagePickerController()
        picker.sourceType = .camera
        picker.delegate = context.coordinator
        return picker
    }

    func updateUIViewController(_ picker: UIImagePickerController, context: Context) {}

    func makeCoordinator() -> Coordinator { Coordinator(self) }

    final class Coordinator: NSObject, UIImagePickerControllerDelegate, UINavigationControllerDelegate {
        let parent: CameraPicker
        init(_ parent: CameraPicker) { self.parent = parent }

        func imagePickerController(_ picker: UIImagePickerController, didFinishPickingMediaWithInfo info: [UIImagePickerController.InfoKey: Any]) {
            if let image = info[.originalImage] as? UIImage, let jpeg = image.jpegData(compressionQuality: 0.92) { parent.taken(jpeg) }
            parent.dismiss()
        }

        func imagePickerControllerDidCancel(_ picker: UIImagePickerController) {
            parent.dismiss()
        }
    }
}
#endif
