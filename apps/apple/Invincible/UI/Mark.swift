import SwiftUI

/*
 * Invincible's mark, the I-beam (scripts/mark.ts, the owner's choice of 26 November 2026: "minimal bold monochrome"): one
 * solid form in one ink, the steel section and the letter I. The app icon is drawn from the same three rectangles, and
 * MarkTests holds this shape to them through the vectors. In the app it is the app's own mark (joining, About, a Mac's
 * first run, the sidebar's head) and the primary's: the one you talk to is shown by the I-beam in ink, never an orb;
 * the agents keep their orbs, the only colour on a page besides what went wrong.
 */

/// The I-beam as a shape, to be filled with any ink: its 100-unit box centred in the frame, on its shorter side, at the
/// icon's own share of it (MARK_BOX), so it sits in a frame as it sits on the icon's tile.
struct IBeam: Shape {
    /// The top flange, the web, the bottom flange, in the 100-unit box (scripts/mark.ts, MARK_RECTS).
    static let rects = [
        CGRect(x: 22, y: 14, width: 56, height: 16),
        CGRect(x: 41, y: 30, width: 18, height: 40),
        CGRect(x: 22, y: 70, width: 56, height: 16),
    ]
    /// How much of the frame's shorter side the 100-unit box spans (MARK_BOX).
    static let box = 0.7

    func path(in rect: CGRect) -> Path {
        let unit = min(rect.width, rect.height) * Self.box / 100
        let origin = CGPoint(x: rect.midX - 50 * unit, y: rect.midY - 50 * unit)
        var path = Path()
        for part in Self.rects {
            path.addRect(CGRect(x: origin.x + part.minX * unit, y: origin.y + part.minY * unit, width: part.width * unit, height: part.height * unit))
        }
        return path
    }
}

extension View {
    /// A screen named for the UI tests (InvincibleUITests' taps): a container by that name, its contents as they were.
    func screen(_ id: String) -> some View { accessibilityElement(children: .contain).accessibilityIdentifier(id) }
}

/// The app's mark where a page shows it (joining, Settings' About, a Mac's first run, the sidebar's head): the I-beam in
/// the page's ink, on nothing, so it sits on a light page as on a dark one. Decorative: what it is in is named. The ink
/// itself, not `.primary`: an iPad sidebar's bar draws an item that is no button in a muted grey, which `.primary` follows.
struct AppMark: View {
    var size: CGFloat = 40

    var body: some View {
        IBeam()
            .fill(Color.ink)
            .frame(width: size, height: size)
            .accessibilityHidden(true)
    }
}
