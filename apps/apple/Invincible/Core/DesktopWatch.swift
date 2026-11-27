import Foundation

/**
 * An agent's screen kept live (C1 step 9.4), as the web app's viewer keeps it: the node's stream watched while the screen
 * is on screen and the app is in front. A stream that ends is watched again a little later each time (0.5, 1, 2 and 4 s),
 * its last frame kept on screen meanwhile. After DesktopStream.liveTries ends in a row it gives way to the picture every
 * two seconds, saying why; at once, saying nothing, when the node refuses it (an older node, a VM with no stream: a 4xx,
 * or 501). A node that didn't answer isn't a refusal: it is asked again, as is a stream that fell behind
 * (DesktopStream.Behind), from its keyframe. A frame drawn starts the count again. Behinds are counted apart: three in
 * a row, each within 30 s of the last, give way to the picture too, saying this device can't keep up
 * (DesktopStream.behindAgain).
 *
 * The stream, the drawing and the waiting are handed in (AgentScreenView hands in the node's, DesktopLive's and a sleep),
 * so the tests run it on stand-ins.
 */
@MainActor @Observable
final class DesktopWatch {
    /// Why it gave way to the picture.
    enum GivenUp: Equatable {
        /// Tried, and the stream didn't come through: said.
        case tried
        /// The node refused it: nothing to say.
        case refused
        /// This device kept falling behind the screen: said.
        case behind
    }

    /// The stream is drawing now: what is done there asks no picture back, and the picture loop rests.
    private(set) var watching = false
    /// The stream's last frame is what the box shows: from its first frame drawn, between one stream and the next too,
    /// until it gives way to the picture.
    private(set) var drawn = false
    /// It gave way to the picture every two seconds, and why; nil while it is still watched.
    private(set) var givenUp: GivenUp?
    /// Behinds in a row, counted apart from the ends.
    @ObservationIgnored private var behinds: DesktopStream.Behinds?

    /// Watches until it gives way to the picture, or until the task is cancelled (the screen left, the app behind: watched
    /// from the start again when it is back, with nothing counted).
    /// - open: the node's stream of the screen;
    /// - show: one frame drawn, and whether it reached the screen;
    /// - ended: the stream is over (its decoder let go);
    /// - wait: the pause before watching again, in ms;
    /// - began, stopped: a stream's first frame drawn, and a stream that was drawing ended;
    /// - now: this device's clock, in ms since the epoch (the tests' own).
    func run(
        open: () -> AsyncThrowingStream<DesktopFrame, any Error>,
        show: (DesktopFrame) async throws -> Bool,
        ended: () async -> Void,
        wait: (Int) async -> Void,
        began: () -> Void = {},
        stopped: () -> Void = {},
        now: () -> Double = { Date.now.timeIntervalSince1970 * 1000 }
    ) async {
        var tries = 0
        while !Task.isCancelled, givenUp == nil {
            var refused = false
            var behind = false
            do {
                for try await frame in open() {
                    if try await show(frame), !watching {
                        (watching, drawn, tries) = (true, true, 0)
                        began()
                    }
                }
            } catch {
                refused = Self.refuses(error)
                behind = error is DesktopStream.Behind
            }
            await ended()
            if watching {
                watching = false
                stopped()
            }
            if Task.isCancelled { return }
            if behind {
                let row = DesktopStream.behindAgain(behinds, at: now())
                behinds = row
                if DesktopStream.behindTooOften(row) {
                    (givenUp, drawn) = (.behind, false)
                    return
                }
            }
            tries += 1
            if refused || tries >= DesktopStream.liveTries {
                (givenUp, drawn) = (refused ? .refused : .tried, false)
                return
            }
            await wait(DesktopStream.againIn(tries))
        }
    }

    /// The node's refusal, which asking again doesn't mend: a 4xx, or 501 where it has no stream. A node that didn't
    /// answer, or a proxy that answered for one that's away, is asked again.
    nonisolated static func refuses(_ error: any Error) -> Bool {
        guard let error = error as? NodeError, !error.unreachable else { return false }
        return (400..<500).contains(error.status) || error.status == 501
    }
}
