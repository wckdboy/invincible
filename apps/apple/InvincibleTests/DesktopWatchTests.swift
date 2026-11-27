import Foundation
import Testing
@testable import Invincible

/// The way back to the picture (DesktopWatch), on stand-in streams: after four ends in a row, said; at once on the node's
/// refusal, saying nothing; never on a node that didn't answer; the last frame kept on screen between tries, and a frame
/// drawn starting the count again.
@MainActor
struct DesktopWatchTests {
    /// A stream that gives so many frames (a keyframe first), then ends: as streams end, or with an error.
    static func stream(_ frames: Int, then error: (any Error)? = nil) -> AsyncThrowingStream<DesktopFrame, any Error> {
        AsyncThrowingStream { continuation in
            for i in 0..<frames {
                continuation.yield(DesktopFrame(kind: i == 0 ? DesktopFrame.key : DesktopFrame.delta, time: UInt64(i), payload: Data([0, 0, 1, 0x65])))
            }
            continuation.finish(throwing: error)
        }
    }

    /// What the watch did, as its stand-ins saw it.
    final class Seen {
        var opened = 0
        var ended = 0
        var waits: [Int] = []
        /// How it stood at each wait: drawing, and whether its last frame was still what the box shows.
        var during: [(watching: Bool, drawn: Bool)] = []
        var said: [String] = []
    }

    /// The watch run on a script of streams, one for each time it opens one (a stream that ends at once after them).
    func run(_ script: [AsyncThrowingStream<DesktopFrame, any Error>]) async -> (DesktopWatch, Seen) {
        let watch = DesktopWatch()
        let seen = Seen()
        var left = script
        await watch.run(
            open: {
                seen.opened += 1
                return left.isEmpty ? Self.stream(0) : left.removeFirst()
            },
            show: { _ in true },
            ended: { seen.ended += 1 },
            wait: { ms in
                seen.waits.append(ms)
                seen.during.append((watch.watching, watch.drawn))
            },
            began: { seen.said.append("began") },
            stopped: { seen.said.append("stopped") }
        )
        return (watch, seen)
    }

    @Test func fourEndsInARowGiveWayToThePictureAndSaySo() async {
        let (watch, seen) = await run([Self.stream(0), Self.stream(0), Self.stream(0), Self.stream(0)])
        #expect(watch.givenUp == .tried)
        #expect(seen.waits == [500, 1000, 2000])
        #expect(seen.opened == 4 && seen.ended == 4)
        #expect(!watch.watching && !watch.drawn && seen.said.isEmpty)
    }

    @Test func theNodesRefusalGivesWayAtOnceSayingNothing() async {
        for status in [400, 403, 404, 424, 501] {
            let (watch, seen) = await run([Self.stream(0, then: NodeError(status: status, message: "no"))])
            #expect(watch.givenUp == .refused, "\(status)")
            #expect(seen.waits.isEmpty && seen.opened == 1 && seen.ended == 1, "\(status)")
        }
        // Refused after it was drawing: the picture at once, the last frame let go.
        let (watch, seen) = await run([Self.stream(2), Self.stream(0, then: NodeError(status: 404, message: "gone"))])
        #expect(watch.givenUp == .refused && !watch.drawn)
        #expect(seen.waits == [500] && seen.said == ["began", "stopped"])
    }

    @Test func aNodeThatDidntAnswerIsAskedAgainNotRefused() async {
        let away = [
            NodeError(status: 0, message: "nothing answered", unreachable: true),
            NodeError(status: 503, message: "a proxy for a node that's away", unreachable: true),
            NodeError(status: 500, message: "it broke"),
            NodeError(status: 504, message: "a proxy for a node that's away", unreachable: true),
        ]
        for error in away { #expect(!DesktopWatch.refuses(error), "\(error.status)") }
        // Not answered is never a refusal, whatever status came back in its place.
        #expect(!DesktopWatch.refuses(NodeError(status: 404, message: "a proxy's own page", unreachable: true)))
        #expect(!DesktopWatch.refuses(CancellationError()))
        // Asked again each time, and given up only after the fourth end in a row, saying so.
        let (watch, seen) = await run(away.map { Self.stream(0, then: $0) })
        #expect(seen.waits == [500, 1000, 2000] && seen.opened == 4)
        #expect(watch.givenUp == .tried)
    }

    @Test func theLastFrameStaysBetweenTriesAndADrawnFrameStartsTheCountAgain() async {
        let (watch, seen) = await run([
            Self.stream(3), Self.stream(0), Self.stream(0, then: NodeError(status: 0, message: "", unreachable: true)),
            Self.stream(2), Self.stream(0), Self.stream(0), Self.stream(0),
        ])
        // Three ends, then frames drawn again: the count starts over, so it takes four more ends to give up.
        #expect(seen.waits == [500, 1000, 2000, 500, 1000, 2000])
        // At every wait it isn't drawing, and the last frame is still what the box shows.
        #expect(seen.during.count == 6 && seen.during.allSatisfy { !$0.watching && $0.drawn })
        #expect(seen.said == ["began", "stopped", "began", "stopped"])
        // Given up: the picture, not the last frame.
        #expect(watch.givenUp == .tried && !watch.drawn)
    }

    @Test func leftItStopsWithNothingCountedOrGivenUp() async {
        let watch = DesktopWatch()
        let task = Task { @MainActor in
            await watch.run(open: { Self.stream(0) }, show: { _ in true }, ended: {}, wait: { _ in try? await Task.sleep(for: .seconds(60)) })
        }
        // (Wherever the cancel finds it, before its first stream or in its first wait, it stops there.)
        try? await Task.sleep(for: .milliseconds(50))
        task.cancel()
        await task.value
        #expect(watch.givenUp == nil && !watch.watching)
    }
}
