import CoreMedia
import CoreVideo
import Foundation
import Testing
@testable import Invincible

/// An agent's desktop live, as core and the PWA read it (the vectors' desktopStream): its frames as their bytes come, the
/// codec a keyframe is, its slices as VideoToolbox takes them, your take-over's end, and when to watch again.
struct DesktopStreamTests {
    let cases = Vectors.shared.desktopStream

    @Test func framesComeWholeHoweverTheirBytesAreCut() throws {
        let bytes = Data(base64Encoded: cases.bytes)!
        let want = cases.frames.map { "\($0.kind) \($0.time) \($0.payload)" }
        for cut in cases.cuts {
            var frames = DesktopFrames()
            var got: [DesktopFrame] = []
            var from = 0
            for at in cut + [bytes.count] {
                got += try frames.push(bytes.subdata(in: from..<at))
                from = at
            }
            #expect(got.map { "\($0.kind) \($0.time) \($0.payload.base64EncodedString())" } == want, "cut at \(cut)")
        }
        // One byte at a time, as the app reads them.
        var frames = DesktopFrames()
        let byByte = try bytes.compactMap { try frames.push(byte: $0) }
        #expect(byByte.count == cases.frames.count)
        #expect(DesktopFrames.header == cases.header && DesktopFrames.most == cases.most)
    }

    @Test func whatIsNoStreamOfFramesIsRefusedNeverReadAsOne() {
        for each in cases.refused {
            var frames = DesktopFrames()
            #expect(throws: DesktopFrames.NotFrames.self) { try frames.push(Data(base64Encoded: each)!) }
        }
    }

    @Test func aKeyframesCodecIsReadFromItsSPSAsThePWAReadsIt() {
        for each in cases.codecs {
            #expect(DesktopStream.codec(Data(base64Encoded: each.payload)!) == each.codec, "\(each.payload)")
        }
    }

    @Test func aFramesSlicesGoToVideoToolboxEachAfterItsLengthItsParameterSetsToItsFormat() throws {
        let key = Data(base64Encoded: cases.frames[0].payload)!
        // The delimiter, the SPS and the PPS are left out of the sample; the IDR slice goes after its 4-byte length.
        #expect([UInt8](DesktopStream.avcc(key)) == [0, 0, 0, 5, 0x65, 0x88, 0x84, 0x00, 0x33])
        let sets = try #require(DesktopStream.parameterSets(key))
        #expect([UInt8](sets.sps) == [0x67, 0x42, 0xC0, 0x1F, 0xDA, 0x01, 0x40])
        #expect([UInt8](sets.pps) == [0x68, 0xCE, 0x3C, 0x80])
        // A frame with no parameter sets has none to give.
        #expect(DesktopStream.parameterSets(Data(base64Encoded: cases.frames[1].payload)!) == nil)
    }

    @Test func aHoldEndsWhenTheNodeSaidAndWatchingAgainWaitsALittleLongerEachTime() {
        for each in cases.holds { #expect(each.held.ends(said: each.at) == each.ends) }
        for each in cases.again { #expect(DesktopStream.againIn(each.n) == each.ms, "try \(each.n)") }
        #expect(DesktopStream.liveTries == cases.liveTries)
    }
}

/// The glass page's recording (the vectors' desktopStream.glass), decoded by VideoToolbox as the live screen decodes it:
/// each frame's strip read back from its pixels says the time and the clicks it was drawn with.
struct DesktopVideoTests {
    let glass = Vectors.shared.desktopStream.glass

    @Test func eachFrameDecodesToThePixelsItWasDrawnWith() throws {
        let url = try #require(Bundle(for: FixtureToken.self).url(forResource: "desktop-glass", withExtension: "frames"))
        var parser = DesktopFrames()
        let frames = try parser.push(Data(contentsOf: url))
        #expect(frames.map(\.kind) == glass.frames.map(\.kind))
        let sets = try #require(DesktopStream.parameterSets(frames[0].payload))
        let format = try DesktopVideo.format(sps: sets.sps, pps: sets.pps)
        let size = DesktopVideo.size(format)
        #expect(size.width == 1280 && size.height == 800)
        let decoder = try DesktopDecoder(format: format)
        for (i, frame) in frames.enumerated() {
            let pixels = try decoder.decode(DesktopVideo.sample(frame.payload, format: format, time: frame.time))
            let read = strip(pixels)
            #expect(read?.time == glass.frames[i].time && read?.clicks == glass.frames[i].clicks, "frame \(i): \(String(describing: read))")
        }
    }

    /// The strip read from BGRA pixels as glass-clock.ts reads it: each block's middle, plainly black or plainly white,
    /// the sync blocks first and the check last; looked for in the rows below the top.
    private func strip(_ pixels: CVPixelBuffer) -> (time: UInt64, clicks: Int)? {
        CVPixelBufferLockBaseAddress(pixels, .readOnly)
        defer { CVPixelBufferUnlockBaseAddress(pixels, .readOnly) }
        guard let base = CVPixelBufferGetBaseAddress(pixels)?.assumingMemoryBound(to: UInt8.self) else { return nil }
        let row = CVPixelBufferGetBytesPerRow(pixels)
        let level = { (x: Int, y: Int) -> Double in
            let p = base + y * row + x * 4
            return 0.114 * Double(p[0]) + 0.587 * Double(p[1]) + 0.299 * Double(p[2])
        }
        let s = glass.strip
        let sync = [1, 0, 1, 1, 0, 0, 1, 0]
        func bit(_ i: Int, _ y: Int) -> Int {
            let x = s.x + i * s.block + s.block / 2
            var sum = 0.0
            for dx in [-3, 0, 3] { for dy in [-3, 0, 3] { sum += level(x + dx, y + dy) } }
            let mean = sum / 9
            return mean > 160 ? 1 : mean < 96 ? 0 : -1
        }
        for top in 0...40 {
            let y = top + s.y + s.block / 2
            guard (0..<8).allSatisfy({ bit($0, y) == sync[$0] }) else { continue }
            let bits = (8..<s.bits).map { bit($0, y) }
            guard !bits.contains(-1) else { continue }
            let check = (0..<50).reduce(0) { $0 + bits[$1] * ($1 + 1) } % 64
            guard check == bits[50..<56].reduce(0, { $0 * 2 + $1 }) else { continue }
            let time = bits[0..<42].reduce(UInt64(0)) { $0 * 2 + UInt64($1) }
            return (time, bits[42..<50].reduce(0) { $0 * 2 + $1 })
        }
        return nil
    }
}

private final class FixtureToken {}
