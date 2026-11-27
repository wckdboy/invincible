import CoreMedia
import SwiftUI

/*
 * An agent's desktop live on this device (C1 step 9.4): the node's stream of its screen, each frame decoded as it comes
 * by VideoToolbox off the main actor (DesktopDecoding) and shown at once, its IOSurface a layer's contents. The format
 * comes from each keyframe's SPS and PPS (DesktopVideo); a frame before the first keyframe is passed by, as the node
 * sends none. AgentScreenView watches; this shows.
 */

#if os(iOS)
/// The screen's view: its layer shows each frame's pixels, fitted to it.
final class DesktopLayerView: UIView {
    /// The frame shown, kept until the next, so its surface isn't the decoder's again while it is on screen.
    private var shown: CVPixelBuffer?
    override init(frame: CGRect) {
        super.init(frame: frame)
        layer.contentsGravity = .resizeAspect
        isOpaque = false
    }
    required init?(coder: NSCoder) { nil }
    /// (A layer shows a frame's IOSurface as it is, with no copy; a pixel buffer as the contents shows nothing.)
    func show(_ pixels: CVPixelBuffer) {
        shown = pixels
        layer.contents = CVPixelBufferGetIOSurface(pixels)?.takeUnretainedValue()
    }
}
#else
final class DesktopLayerView: NSView {
    private var shown: CVPixelBuffer?
    override init(frame: NSRect) {
        super.init(frame: frame)
        wantsLayer = true
        layer?.contentsGravity = .resizeAspect
    }
    required init?(coder: NSCoder) { nil }
    func show(_ pixels: CVPixelBuffer) {
        shown = pixels
        layer?.contents = CVPixelBufferGetIOSurface(pixels)?.takeUnretainedValue()
    }
}
#endif

@MainActor @Observable
final class DesktopLive {
    let view = DesktopLayerView()
    /// The screen's size in its own pixels, as its keyframe says: where a tap lands.
    private(set) var size: (width: Int, height: Int)?
    /// A frame has been shown since the stream began.
    private(set) var live = false
    /// Where the frames are decoded: off the main actor, which only shows what comes out.
    @ObservationIgnored private let decoding = DesktopDecoding()

    /// One frame of the stream, decoded off the main actor and then shown here: only its IOSurface goes to the layer.
    func show(_ frame: DesktopFrame) async throws {
        guard let picture = try await decoding.decode(frame) else { return }
        view.show(picture.pixels)
        if size?.width != picture.width || size?.height != picture.height { size = (picture.width, picture.height) }
        if !live { live = true }
    }

    /// The stream ended: the next one starts from its own keyframe; what was shown stays until then.
    func ended() async {
        live = false
        await decoding.reset()
    }
}

#if os(iOS)
struct DesktopLiveScreen: UIViewRepresentable {
    let live: DesktopLive
    func makeUIView(context: Context) -> DesktopLayerView { live.view }
    func updateUIView(_ view: DesktopLayerView, context: Context) {}
}
#else
struct DesktopLiveScreen: NSViewRepresentable {
    let live: DesktopLive
    func makeNSView(context: Context) -> DesktopLayerView { live.view }
    func updateNSView(_ view: DesktopLayerView, context: Context) {}
}
#endif
