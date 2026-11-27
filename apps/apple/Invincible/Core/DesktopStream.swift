import Foundation

/*
 * An agent's desktop live (C1 step 9.4), as core's desktop-frames.ts and the PWA's lib/desktop-stream.ts read it: the
 * node's stream of its screen (POST /api/team/desktop/stream), frames read whole as their bytes come; the codec a
 * keyframe is; a frame's NAL units as VideoToolbox takes them; your take-over as the node says it; and when to watch
 * again. Pure: DesktopVideo decodes, DesktopLive shows.
 *
 * Each frame: a 4-byte big-endian length of what follows it, a byte for its kind (0 a beat, 1 a keyframe, 2 any other;
 * one this app doesn't know is passed by), an 8-byte big-endian time in milliseconds since the epoch, then its payload:
 * the screen's H.264 NAL units, Annex B, Constrained Baseline; nothing for a beat.
 */

struct DesktopFrame: Equatable, Sendable {
    let kind: UInt8
    /// Milliseconds since the epoch: when its screen was captured (a beat's: when the node sent it).
    let time: UInt64
    /// The NAL units, Annex B; nothing for a beat.
    let payload: Data

    static let beat: UInt8 = 0
    static let key: UInt8 = 1
    static let delta: UInt8 = 2
}

/// A stream's frames as its bytes come. A length no frame has is no stream of frames: it throws.
struct DesktopFrames {
    /// The length, the kind and the time: what comes before a frame's payload.
    static let header = 13
    /// The most a frame may be (core's DESKTOP_FRAME_MAX).
    static let most = 8 * 1024 * 1024

    struct NotFrames: Error, Equatable { let length: Int }

    private var held = Data()
    /// What follows the 4-byte length, once it is read; -1 before.
    private var length = -1

    /// One byte more of the stream: the frame it ends, if it ends one.
    mutating func push(byte: UInt8) throws -> DesktopFrame? {
        held.append(byte)
        if length < 0 {
            guard held.count == 4 else { return nil }
            let n = held.withUnsafeBytes { Int($0.loadUnaligned(as: UInt32.self).bigEndian) }
            guard n >= Self.header - 4, n <= Self.most else { throw NotFrames(length: n) }
            length = n
            held.reserveCapacity(4 + n)
            return nil
        }
        guard held.count == 4 + length else { return nil }
        let frame = held.withUnsafeBytes { raw in
            DesktopFrame(kind: raw[4], time: raw.loadUnaligned(fromByteOffset: 5, as: UInt64.self).bigEndian, payload: Data(raw[Self.header...]))
        }
        held.removeAll(keepingCapacity: true)
        length = -1
        return frame
    }

    /// Bytes of the stream, in a piece of any size: the frames they end.
    mutating func push(_ bytes: Data) throws -> [DesktopFrame] {
        var frames: [DesktopFrame] = []
        for byte in bytes {
            if let frame = try push(byte: byte) { frames.append(frame) }
        }
        return frames
    }
}

enum DesktopStream {
    /// Each NAL unit of an Annex B stretch, without its start code (00 00 01, or 00 00 00 01).
    static func nalUnits(_ annexB: Data) -> [Data] {
        let bytes = [UInt8](annexB)
        var starts: [Int] = []
        var i = 0
        while i + 2 < bytes.count {
            if bytes[i] == 0, bytes[i + 1] == 0, bytes[i + 2] == 1 {
                starts.append(i + 3)
                i += 3
            } else {
                i += 1
            }
        }
        return starts.enumerated().map { n, start in
            var end = n + 1 < starts.count ? starts[n + 1] - 3 : bytes.count
            // (A four-byte start code's leading zero belongs to it, not to the unit before.)
            if n + 1 < starts.count, end > start, bytes[end - 1] == 0 { end -= 1 }
            return Data(bytes[start..<end])
        }
    }

    /// A NAL unit's type (5 an IDR slice, 7 an SPS, 8 a PPS, 9 an access unit delimiter).
    static func type(_ unit: Data) -> UInt8 { unit.first.map { $0 & 0x1F } ?? 0 }

    /// The codec a keyframe is (RFC 6381): avc1, then its SPS's profile, constraints and level. Nil with no SPS.
    static func codec(_ keyframe: Data) -> String? {
        guard let sps = nalUnits(keyframe).first(where: { type($0) == 7 && $0.count >= 4 }) else { return nil }
        let bytes = [UInt8](sps)
        return "avc1." + bytes[1...3].map { String(format: "%02X", $0) }.joined()
    }

    /// A keyframe's SPS and PPS, the first of each: what VideoToolbox's format is made from. Nil without both.
    static func parameterSets(_ keyframe: Data) -> (sps: Data, pps: Data)? {
        let units = nalUnits(keyframe)
        guard let sps = units.first(where: { type($0) == 7 }), let pps = units.first(where: { type($0) == 8 }) else { return nil }
        return (sps, pps)
    }

    /// A frame's slices as VideoToolbox decodes them (AVCC): each NAL unit after its 4-byte big-endian length, the
    /// delimiters and parameter sets left out (they are the format's, not the sample's).
    static func avcc(_ annexB: Data) -> Data {
        var out = Data()
        for unit in nalUnits(annexB) where ![7, 8, 9].contains(type(unit)) {
            withUnsafeBytes(of: UInt32(unit.count).bigEndian) { out.append(contentsOf: $0) }
            out.append(unit)
        }
        return out
    }

    /// How long to wait before watching again after the stream's nth end in a row (from 1): 0.5, 1, 2 and 4 s, then 5 s.
    static func againIn(_ n: Int) -> Int { min(5000, 500 * (1 << max(0, min(n - 1, 10)))) }

    /// After this many ends in a row, the live screen gives way to a picture every two seconds, and says so.
    static let liveTries = 4

    /// The most frames that may wait to be decoded (the web's BEHIND, in its views/desktop.ts). Past that, this device
    /// has fallen behind the screen: the stream is ended and watched again from a fresh keyframe, so what it holds and
    /// how far behind it shows stay bounded.
    static let behind = 20

    /// A stream that fell behind: more than `behind` of its frames waited to be decoded. It is no refusal: the watch opens
    /// the stream again, and the new one starts from its keyframe.
    struct Behind: Error, Equatable {}

    /// Where a stream's frames wait to be decoded: at most `behind` of them, the oldest first.
    static func queue() -> (frames: AsyncThrowingStream<DesktopFrame, any Error>, queue: AsyncThrowingStream<DesktopFrame, any Error>.Continuation) {
        let made = AsyncThrowingStream.makeStream(of: DesktopFrame.self, throwing: (any Error).self, bufferingPolicy: .bufferingOldest(behind))
        return (made.stream, made.continuation)
    }

    /// One frame queued to be decoded; false once the stream is over: its watcher went, or it fell behind, and then it
    /// ends with Behind, after the frames that wait.
    static func enqueue(_ frame: DesktopFrame, on queue: AsyncThrowingStream<DesktopFrame, any Error>.Continuation) -> Bool {
        switch queue.yield(frame) {
        case .enqueued:
            return true
        case .dropped:
            queue.finish(throwing: Behind())
            return false
        case .terminated:
            return false
        @unknown default:
            return false
        }
    }
}

/// Your take-over as the node says it (`held`, on each answer of /api/team/desktop and of take and release).
struct DesktopHold: Codable, Equatable, Sendable {
    /// When you took it, in milliseconds since the epoch.
    let since: Double
    let idleSec: Double
    let mostSec: Double
    /// How long it had left when the node said it: your next input starts its idle time again.
    let endsInSec: Double

    /// When it ends by this device's clock, in milliseconds, if nothing more is done there: `said`, when the node said it.
    func ends(said: Double) -> Double { said + endsInSec * 1000 }
}

/// A thing done with no picture asked back (while it is live), or a look that asks only whether you have the desktop.
struct DesktopDone: Decodable, Sendable {
    let done: Bool
    let held: DesktopHold?
}
