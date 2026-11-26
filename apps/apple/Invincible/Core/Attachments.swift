import Foundation
import ImageIO
import PDFKit
import UniformTypeIdentifiers

/// A file kept on the node for a message of yours (core's `AttachmentRef`): what the message names it by.
struct AttachmentRef: Codable, Hashable, Sendable {
    /// The SHA-256 of its bytes, in hex.
    let id: String
    let name: String
    /// image/png · image/jpeg · image/webp · image/gif · text/plain
    let type: String
    let bytes: Int

    var isPicture: Bool { type != "text/plain" }
}

/**
 * Files with a message, on this side (the node keeps them: packages/node/src/uploads.ts; the PWA's lib/attachments.ts).
 * What a file is, is read from its bytes by the node's own rule (packages/core/src/attachments.ts), never from its
 * name. A picture is drawn again before it goes, at most `side` pixels on its long side, as a new image: its metadata
 * (where a photo was taken, the camera) is never copied into it. A GIF goes as it is. A PDF is read here, into its
 * words (a text), or for a scan, its first pages drawn as pictures; anything else must be text.
 */
enum Attachments {
    /// core's ATTACHMENT_LIMITS.
    static let perMessage = 8
    static let pictureBytes = 5 * 1024 * 1024
    static let textBytes = 256 * 1024
    /// A picture's long side, at most: what Claude scales a picture down to anyway, so more would only cost more.
    static let side = 1568

    /// What a picture is by its first bytes (each format's own signature), or nil when it is none of the four.
    static func pictureType(_ data: Data) -> String? {
        let b = [UInt8](data.prefix(12))
        func starts(_ sig: [UInt8]) -> Bool { b.count >= sig.count && Array(b.prefix(sig.count)) == sig }
        if starts([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]) { return "image/png" }
        if starts([0xFF, 0xD8, 0xFF]) { return "image/jpeg" }
        if starts([0x47, 0x49, 0x46, 0x38]), b.count >= 6, b[4] == 0x37 || b[4] == 0x39, b[5] == 0x61 { return "image/gif" }
        if starts([0x52, 0x49, 0x46, 0x46]), b.count >= 12, b[8] == 0x57, b[9] == 0x45, b[10] == 0x42, b[11] == 0x50 { return "image/webp" }
        return nil
    }

    /// Whether these bytes are text: UTF-8, with no NUL.
    static func isText(_ data: Data) -> Bool {
        !data.contains(0) && String(data: data, encoding: .utf8) != nil
    }

    /// A file's name as the node takes it: no folders, no control characters, at most 200 characters.
    static func name(_ raw: String) -> String {
        let last = raw.split(whereSeparator: { $0 == "/" || $0 == "\\" }).last.map(String.init) ?? ""
        let clean = String(last.unicodeScalars.filter { $0.value >= 0x20 && $0.value != 0x7F }).trimmingCharacters(in: .whitespaces)
        return clean.isEmpty ? "file" : String(clean.prefix(200))
    }

    /// A file ready to go up: its name, what its bytes are, and the bytes.
    struct Prepared: Sendable, Equatable {
        let name: String
        let type: String
        let data: Data
    }

    struct Refused: LocalizedError, Equatable {
        let errorDescription: String?
    }

    /// Why a file can't go with a message, in words; nil when it can.
    static func refusal(name: String, type: String?, size: Int) -> String? {
        guard let type else { return "\(name) isn't a picture, a PDF or text: only those go with a message." }
        if size == 0 { return "\(name) is empty." }
        let text = type == "text/plain"
        let limit = text ? textBytes : pictureBytes
        return size > limit ? "\(name) is too big: \(text ? "a text goes with a message up to 256 KB" : "a picture goes with a message up to 5 MB")." : nil
    }

    /// A file you chose (a photo, a picture, a text), made ready to go up, or why it can't.
    static func prepare(name raw: String, data: Data) throws -> Prepared {
        let name = name(raw)
        let was = pictureType(data)
        // A GIF goes as it is: drawn again, it would lose its frames.
        if was == "image/gif" {
            if let why = refusal(name: name, type: was, size: data.count) { throw Refused(errorDescription: why) }
            return Prepared(name: name, type: "image/gif", data: data)
        }
        // A picture of the four, or one ImageIO reads that isn't (a HEIC from the camera), is drawn again.
        if was != nil || (!isText(data) && readable(data)) {
            guard let redrawn = redraw(data, keepPNG: was == "image/png") else { throw Refused(errorDescription: "\(name) is a picture this app can't read: save it as a JPEG or PNG first.") }
            if let why = refusal(name: name, type: redrawn.type, size: redrawn.data.count) { throw Refused(errorDescription: why) }
            return Prepared(name: redrawn.type == "image/jpeg" ? jpegName(name) : name, type: redrawn.type, data: redrawn.data)
        }
        if let why = refusal(name: name, type: isText(data) ? "text/plain" : nil, size: data.count) { throw Refused(errorDescription: why) }
        return Prepared(name: name, type: "text/plain", data: data)
    }

    /// A file you chose, made ready to go up as what a model can take: a PDF as its words, or (a scan, with none) its
    /// first pages as pictures; anything else as `prepare` makes it.
    static func prepareAll(name raw: String, data: Data) throws -> [Prepared] {
        guard isPDF(data) else { return [try prepare(name: raw, data: data)] }
        guard let pdf = PDFDocument(data: data), pdf.pageCount > 0 else { throw Refused(errorDescription: "\(name(raw)) is a PDF this app can't read.") }
        if pdf.isLocked { throw Refused(errorDescription: "\(name(raw)) is locked with a password: unlock it, or send what you need from it as text.") }
        let name = name(raw)
        if let words = pdfWords(pdf, name: name) { return [Prepared(name: name, type: "text/plain", data: Data(words.utf8))] }
        let stem = name.replacing(#/\.pdf$/#.ignoresCase(), with: "")
        let pages = (0..<min(pdf.pageCount, pdfPages)).compactMap { at -> Prepared? in
            guard let page = pdf.page(at: at), let jpeg = drawn(page) else { return nil }
            return Prepared(name: pdf.pageCount == 1 ? "\(stem).jpg" : "\(stem), page \(at + 1).jpg", type: "image/jpeg", data: jpeg)
        }
        guard !pages.isEmpty else { throw Refused(errorDescription: "\(name) is a PDF this app can't draw.") }
        return pages
    }

    /// At most so many pages of a PDF that has no words go, as pictures: a message carries eight files at most.
    static let pdfPages = 4

    /// Whether these bytes are a PDF (it begins as one).
    static func isPDF(_ data: Data) -> Bool {
        data.starts(with: Array("%PDF-".utf8))
    }

    /// A PDF's words as one text a model reads, saying where they came from, cut to what a text may be (nil: it has
    /// too few to be its words: a scan).
    static func pdfWords(_ pdf: PDFDocument, name: String) -> String? {
        let words = (pdf.string ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        guard words.count >= 20 else { return nil }
        let head = "[The words of \(name), read from the PDF on your device (\(pdf.pageCount) page\(pdf.pageCount == 1 ? "" : "s")): its pictures and layout aren't here.]\n\n"
        let cut = "\n\n[… the rest of the PDF is cut here: a text goes with a message up to 256 KB …]"
        var text = head + words
        if text.utf8.count > textBytes {
            var kept = head + words
            while kept.utf8.count > textBytes - cut.utf8.count { kept = String(kept.prefix(kept.count * 9 / 10)) }
            text = kept + cut
        }
        return text
    }

    /// A PDF's page drawn on white, at most `side` pixels on its long side, as a JPEG.
    static func drawn(_ page: PDFPage) -> Data? {
        let bounds = page.bounds(for: .mediaBox)
        guard bounds.width > 0, bounds.height > 0 else { return nil }
        let scale = CGFloat(side) / max(bounds.width, bounds.height)
        let width = Int(bounds.width * scale), height = Int(bounds.height * scale)
        guard let context = CGContext(data: nil, width: width, height: height, bitsPerComponent: 8, bytesPerRow: 0, space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue) else { return nil }
        context.setFillColor(CGColor(red: 1, green: 1, blue: 1, alpha: 1))
        context.fill(CGRect(x: 0, y: 0, width: width, height: height))
        context.scaleBy(x: scale, y: scale)
        page.draw(with: .mediaBox, to: context)
        guard let image = context.makeImage() else { return nil }
        let out = NSMutableData()
        guard let destination = CGImageDestinationCreateWithData(out, UTType.jpeg.identifier as CFString, 1, nil) else { return nil }
        CGImageDestinationAddImage(destination, image, [kCGImageDestinationLossyCompressionQuality: 0.86] as CFDictionary)
        return CGImageDestinationFinalize(destination) ? out as Data : nil
    }

    /// Whether ImageIO reads these bytes as a picture of some kind.
    static func readable(_ data: Data) -> Bool {
        guard let source = CGImageSourceCreateWithData(data as CFData, nil) else { return false }
        return CGImageSourceGetType(source) != nil && CGImageSourceGetCount(source) > 0
    }

    /// The name of a picture drawn again as a JPEG: its own, ending in .jpg.
    static func jpegName(_ name: String) -> String {
        "\(name.replacing(#/\.(png|webp|heic|heif|jpe?g|tiff?|bmp|avif)$/#.ignoresCase(), with: "")).jpg"
    }

    /// A picture drawn again at most `side` pixels on its long side, upright, as a new image with none of the old one's
    /// metadata: a PNG (where it was one and still fits) or a JPEG.
    static func redraw(_ data: Data, keepPNG: Bool) -> (data: Data, type: String)? {
        guard let source = CGImageSourceCreateWithData(data as CFData, nil) else { return nil }
        let options: [CFString: Any] = [
            kCGImageSourceCreateThumbnailFromImageAlways: true,
            kCGImageSourceCreateThumbnailWithTransform: true,
            kCGImageSourceThumbnailMaxPixelSize: side,
            kCGImageSourceShouldCacheImmediately: true,
        ]
        guard let image = CGImageSourceCreateThumbnailAtIndex(source, 0, options as CFDictionary) else { return nil }
        func encoded(_ type: UTType, quality: Double?) -> Data? {
            let out = NSMutableData()
            guard let destination = CGImageDestinationCreateWithData(out, type.identifier as CFString, 1, nil) else { return nil }
            // Only how it is compressed: nothing of the photo's own properties is handed over.
            CGImageDestinationAddImage(destination, image, quality.map { [kCGImageDestinationLossyCompressionQuality: $0] as CFDictionary })
            return CGImageDestinationFinalize(destination) ? out as Data : nil
        }
        if keepPNG, let png = encoded(.png, quality: nil), png.count <= pictureBytes { return (png, "image/png") }
        return encoded(.jpeg, quality: 0.86).map { ($0, "image/jpeg") }
    }
}
