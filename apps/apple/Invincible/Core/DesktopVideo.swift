import CoreMedia
import Foundation
import VideoToolbox

/*
 * An agent's desktop's frames (DesktopStream) as VideoToolbox takes them (C1 step 9.4): the format from a keyframe's SPS
 * and PPS, each frame a sample of its slices, DesktopDecoder, which decodes them to pixels one at a time, in order, and
 * DesktopDecoding, which does that off the main actor for the stream as it comes. DesktopLive shows those pixels; the
 * tests read the glass clock in them.
 */

enum DesktopVideo {
    struct Unreadable: Error, Equatable { let what: String; let status: OSStatus }

    /// The format a keyframe's SPS and PPS say: H.264, its size, its NAL units each after a 4-byte length (AVCC).
    static func format(sps: Data, pps: Data) throws -> CMVideoFormatDescription {
        var format: CMFormatDescription?
        let status = sps.withUnsafeBytes { s in
            pps.withUnsafeBytes { p in
                let sets = [s.bindMemory(to: UInt8.self).baseAddress!, p.bindMemory(to: UInt8.self).baseAddress!]
                return CMVideoFormatDescriptionCreateFromH264ParameterSets(allocator: kCFAllocatorDefault, parameterSetCount: 2, parameterSetPointers: sets, parameterSetSizes: [sps.count, pps.count], nalUnitHeaderLength: 4, formatDescriptionOut: &format)
            }
        }
        guard status == noErr, let format else { throw Unreadable(what: "the keyframe's SPS and PPS", status: status) }
        return format
    }

    /// The screen's size in its own pixels, as the format says it.
    static func size(_ format: CMVideoFormatDescription) -> (width: Int, height: Int) {
        let d = CMVideoFormatDescriptionGetDimensions(format)
        return (Int(d.width), Int(d.height))
    }

    /// One frame (Annex B) as a sample of its slices in that format, at its time (ms).
    static func sample(_ annexB: Data, format: CMVideoFormatDescription, time: UInt64) throws -> CMSampleBuffer {
        let data = DesktopStream.avcc(annexB)
        var block: CMBlockBuffer?
        var status = CMBlockBufferCreateWithMemoryBlock(allocator: kCFAllocatorDefault, memoryBlock: nil, blockLength: data.count, blockAllocator: kCFAllocatorDefault, customBlockSource: nil, offsetToData: 0, dataLength: data.count, flags: kCMBlockBufferAssureMemoryNowFlag, blockBufferOut: &block)
        guard status == noErr, let block else { throw Unreadable(what: "a frame's memory", status: status) }
        status = data.withUnsafeBytes { CMBlockBufferReplaceDataBytes(with: $0.baseAddress!, blockBuffer: block, offsetIntoDestination: 0, dataLength: data.count) }
        guard status == noErr else { throw Unreadable(what: "a frame's bytes", status: status) }
        var timing = CMSampleTimingInfo(duration: .invalid, presentationTimeStamp: CMTime(value: CMTimeValue(time), timescale: 1000), decodeTimeStamp: .invalid)
        var size = data.count
        var sample: CMSampleBuffer?
        status = CMSampleBufferCreateReady(allocator: kCFAllocatorDefault, dataBuffer: block, formatDescription: format, sampleCount: 1, sampleTimingEntryCount: 1, sampleTimingArray: &timing, sampleSizeEntryCount: 1, sampleSizeArray: &size, sampleBufferOut: &sample)
        guard status == noErr, let sample else { throw Unreadable(what: "a frame", status: status) }
        return sample
    }
}

/// Frames decoded to pixels, one at a time, in order (a keyframe first): VideoToolbox's decompression session (the
/// hardware's), its pixels BGRA in an IOSurface, which a layer shows as they are.
final class DesktopDecoder {
    private let session: VTDecompressionSession

    init(format: CMVideoFormatDescription) throws {
        var made: VTDecompressionSession?
        let pixels: [String: Any] = [kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA, kCVPixelBufferIOSurfacePropertiesKey as String: [String: Any]()]
        let status = VTDecompressionSessionCreate(allocator: kCFAllocatorDefault, formatDescription: format, decoderSpecification: nil, imageBufferAttributes: pixels as CFDictionary, outputCallback: nil, decompressionSessionOut: &made)
        guard status == noErr, let made else { throw DesktopVideo.Unreadable(what: "a decoder for that format", status: status) }
        session = made
    }

    deinit { VTDecompressionSessionInvalidate(session) }

    /// What the session's handler hands back. (It runs before decode returns, with no asynchronous decompression asked.)
    private final class Decoded: @unchecked Sendable {
        var image: CVPixelBuffer?
        var status: OSStatus = noErr
    }

    /// One frame's pixels (decoded at once, before this returns).
    func decode(_ sample: CMSampleBuffer) throws -> CVPixelBuffer {
        let out = Decoded()
        let status = VTDecompressionSessionDecodeFrame(session, sampleBuffer: sample, flags: [], infoFlagsOut: nil) { status, _, image, _, _ in
            out.status = status
            out.image = image
        }
        guard status == noErr, out.status == noErr, let image = out.image else { throw DesktopVideo.Unreadable(what: "a frame's pixels", status: status != noErr ? status : out.status) }
        return image
    }
}

/// The stream's frames decoded off the main actor, one at a time, in order: a format and a decoder made from each keyframe
/// whose SPS is new. The main actor only shows what comes out (DesktopLive), so a frame's decoding never holds it.
actor DesktopDecoding {
    /// One frame's pixels, and the screen's size in its own pixels, handed over to be shown: nothing here touches them again.
    struct Picture: @unchecked Sendable {
        let pixels: CVPixelBuffer
        let width: Int
        let height: Int
    }

    private var decoder: DesktopDecoder?
    private var format: CMVideoFormatDescription?
    private var sps: Data?

    /// A keyframe's or another frame's pixels; nil for a beat, a kind this app doesn't know, and any frame before the first
    /// keyframe (the node sends none).
    func decode(_ frame: DesktopFrame) throws -> Picture? {
        guard frame.kind == DesktopFrame.key || frame.kind == DesktopFrame.delta else { return nil }
        if frame.kind == DesktopFrame.key, let sets = DesktopStream.parameterSets(frame.payload), sets.sps != sps {
            let made = try DesktopVideo.format(sps: sets.sps, pps: sets.pps)
            decoder = try DesktopDecoder(format: made)
            (format, sps) = (made, sets.sps)
        }
        guard let format, let decoder else { return nil }
        let pixels = try decoder.decode(DesktopVideo.sample(frame.payload, format: format, time: frame.time))
        let size = DesktopVideo.size(format)
        return Picture(pixels: pixels, width: size.width, height: size.height)
    }

    /// The stream ended: the next one starts from its own keyframe.
    func reset() {
        (decoder, format, sps) = (nil, nil, nil)
    }
}
