import CoreGraphics
import CoreText
import Foundation
import ImageIO
import Testing
import UniformTypeIdentifiers
@testable import Invincible

/// Files with a message, on this side (Core/Attachments.swift): what a file is by its bytes, as the node reads it; a
/// photo drawn again smaller with none of its metadata (where it was taken); and the message as the node takes it.
struct AttachmentsTests {
    /// A picture made here, `width` by `height`, as `type`, with a place it was taken when `gps` (as a phone writes it).
    static func picture(width: Int, height: Int, type: UTType, gps: Bool = false) throws -> Data {
        let context = try #require(CGContext(data: nil, width: width, height: height, bitsPerComponent: 8, bytesPerRow: 0, space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue))
        context.setFillColor(red: 0.8, green: 0.1, blue: 0.1, alpha: 1)
        context.fill(CGRect(x: 0, y: 0, width: width / 2, height: height))
        let image = try #require(context.makeImage())
        let out = NSMutableData()
        let destination = try #require(CGImageDestinationCreateWithData(out, type.identifier as CFString, 1, nil))
        let properties: [CFString: Any] = gps
            ? [kCGImagePropertyGPSDictionary: [kCGImagePropertyGPSLatitude: 55.6761, kCGImagePropertyGPSLatitudeRef: "N", kCGImagePropertyGPSLongitude: 12.5683, kCGImagePropertyGPSLongitudeRef: "E"],
               kCGImagePropertyTIFFDictionary: [kCGImagePropertyTIFFModel: "iPhone 17 Pro"]]
            : [:]
        CGImageDestinationAddImage(destination, image, properties as CFDictionary)
        #expect(CGImageDestinationFinalize(destination))
        return out as Data
    }

    static func properties(_ data: Data) throws -> [CFString: Any] {
        let source = try #require(CGImageSourceCreateWithData(data as CFData, nil))
        return try #require(CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [CFString: Any])
    }

    @Test func whatAFileIsIsReadFromItsBytesAsTheNodeReadsIt() throws {
        #expect(Attachments.pictureType(try Self.picture(width: 4, height: 4, type: .png)) == "image/png")
        #expect(Attachments.pictureType(try Self.picture(width: 4, height: 4, type: .jpeg)) == "image/jpeg")
        #expect(Attachments.pictureType(Data("GIF89a\u{1}\u{0}".utf8)) == "image/gif")
        #expect(Attachments.pictureType(Data("RIFF\u{10}\u{0}\u{0}\u{0}WEBPVP8 ".utf8)) == "image/webp")
        #expect(Attachments.pictureType(Data("<svg/>".utf8)) == nil)
        #expect(Attachments.isText(Data("héllo\nwörld".utf8)))
        #expect(!Attachments.isText(Data([0x68, 0x69, 0x00])))
        #expect(!Attachments.isText(Data([0xC3, 0x28])))
        #expect(Attachments.name("/private/var/mobile/../IMG_1234.HEIC") == "IMG_1234.HEIC")
        #expect(Attachments.name("bad\u{0}name\u{7}.txt") == "badname.txt")
        #expect(Attachments.name("  ") == "file")
    }

    @Test func aPhotoIsDrawnAgainSmallerWithNoneOfItsMetadata() throws {
        let photo = try Self.picture(width: 4032, height: 3024, type: .jpeg, gps: true)
        #expect(try Self.properties(photo)[kCGImagePropertyGPSDictionary] != nil)
        let ready = try Attachments.prepare(name: "IMG_1234.JPG", data: photo)
        #expect(ready.type == "image/jpeg")
        #expect(ready.name == "IMG_1234.jpg")
        let after = try Self.properties(ready.data)
        // Where it was taken, and the camera: gone. Its long side: Claude's, at most.
        #expect(after[kCGImagePropertyGPSDictionary] == nil)
        #expect((after[kCGImagePropertyTIFFDictionary] as? [CFString: Any])?[kCGImagePropertyTIFFModel] == nil)
        #expect(after[kCGImagePropertyPixelWidth] as? Int == Attachments.side)
        #expect(after[kCGImagePropertyPixelHeight] as? Int == 1176)
    }

    @Test func aScreenshotStaysAPNGAndAGIFGoesAsItIs() throws {
        let shot = try Self.picture(width: 800, height: 500, type: .png)
        let ready = try Attachments.prepare(name: "Screenshot.png", data: shot)
        #expect(ready.type == "image/png" && ready.name == "Screenshot.png")
        let gif = Data("GIF89a\u{1}\u{0}\u{1}\u{0}".utf8)
        #expect(try Attachments.prepare(name: "spinner.gif", data: gif) == .init(name: "spinner.gif", type: "image/gif", data: gif))
    }

    /// A PDF made here: one page with `words` on it, or blank (a scan holds no words), `pages` long.
    static func pdf(words: String?, pages: Int = 1) throws -> Data {
        let out = NSMutableData()
        var box = CGRect(x: 0, y: 0, width: 612, height: 792)
        let consumer = try #require(CGDataConsumer(data: out as CFMutableData))
        let context = try #require(CGContext(consumer: consumer, mediaBox: &box, nil))
        for _ in 0..<pages {
            context.beginPDFPage(nil)
            context.setFillColor(red: 0.2, green: 0.2, blue: 0.2, alpha: 1)
            context.fill(CGRect(x: 72, y: 600, width: 200, height: 40))
            if let words {
                let line = CTLineCreateWithAttributedString(NSAttributedString(string: words, attributes: [kCTFontAttributeName as NSAttributedString.Key: CTFontCreateWithName("Helvetica" as CFString, 14, nil)]))
                context.textPosition = CGPoint(x: 72, y: 700)
                CTLineDraw(line, context)
            }
            context.endPDFPage()
        }
        context.closePDF()
        return out as Data
    }

    @Test func aPDFGoesAsItsWordsOrAScanAsItsFirstPages() throws {
        let report = try Self.pdf(words: "Quarterly report: revenue grew by eleven percent.")
        let read = try Attachments.prepareAll(name: "report.pdf", data: report)
        #expect(read.count == 1)
        #expect(read[0].name == "report.pdf" && read[0].type == "text/plain")
        let words = String(decoding: read[0].data, as: UTF8.self)
        #expect(words.hasPrefix("[The words of report.pdf, read from the PDF on your device (1 page): its pictures and layout aren't here.]"))
        #expect(words.contains("revenue grew by eleven percent"))
        // A scan holds no words: its first pages go as pictures (four at most), each a JPEG on white.
        let scan = try Self.pdf(words: nil, pages: 6)
        let pages = try Attachments.prepareAll(name: "Scan.PDF", data: scan)
        #expect(pages.map(\.name) == ["Scan, page 1.jpg", "Scan, page 2.jpg", "Scan, page 3.jpg", "Scan, page 4.jpg"])
        #expect(pages.allSatisfy { $0.type == "image/jpeg" && Attachments.pictureType($0.data) == "image/jpeg" })
        // Anything else is as `prepare` makes it; a PDF that isn't one is refused.
        #expect(try Attachments.prepareAll(name: "a.txt", data: Data("hi".utf8)) == [.init(name: "a.txt", type: "text/plain", data: Data("hi".utf8))])
        #expect(throws: Attachments.Refused(errorDescription: "broken.pdf is a PDF this app can't read.")) {
            try Attachments.prepareAll(name: "broken.pdf", data: Data("%PDF-1.7 not really".utf8))
        }
    }

    @Test func textGoesAsItIsAndAnythingElseIsRefusedWithWhy() throws {
        let log = Data("FAIL db.test.ts\n".utf8)
        #expect(try Attachments.prepare(name: "test.log", data: log) == .init(name: "test.log", type: "text/plain", data: log))
        #expect(throws: Attachments.Refused(errorDescription: "core.dump isn't a picture, a PDF or text: only those go with a message.")) {
            try Attachments.prepare(name: "core.dump", data: Data([0x7F, 0x45, 0x4C, 0x46, 0x00, 0x01]))
        }
        #expect(throws: Attachments.Refused(errorDescription: "huge.log is too big: a text goes with a message up to 256 KB.")) {
            try Attachments.prepare(name: "huge.log", data: Data(repeating: 0x61, count: Attachments.textBytes + 1))
        }
        #expect(Attachments.refusal(name: "empty.txt", type: "text/plain", size: 0) == "empty.txt is empty.")
    }

    @Test func aMessageCarriesItsFilesAsTheNodeTakesThem() throws {
        let shot = AttachmentRef(id: String(repeating: "a", count: 64), name: "shot.png", type: "image/png", bytes: 1200)
        let request = ChatRequest(role: "planner", save: true, conversation: nil, messages: [.init(role: "user", content: "", attachments: [shot])])
        let sent = try #require(JSONSerialization.jsonObject(with: JSONEncoder().encode(request)) as? [String: Any])
        let message = try #require((sent["messages"] as? [[String: Any]])?.first)
        #expect(message["content"] as? String == "")
        #expect((message["attachments"] as? [[String: Any]])?.first?["name"] as? String == "shot.png")
        // A message with none has no such field at all (core's ChatMessage is strict).
        let plain = try JSONEncoder().encode(ChatRequest.Message(role: "user", content: "Hello"))
        #expect(!String(decoding: plain, as: UTF8.self).contains("attachments"))
        // Kept, and read back: the turn carries them; one sent from here does too.
        let kept = try JSONDecoder().decode(StoredMessage.self, from: Data(#"{"id":7,"role":"user","content":"Why?","attachments":[{"id":"\#(shot.id)","name":"shot.png","type":"image/png","bytes":1200}],"model":null,"steps":[],"status":"done","error":null}"#.utf8))
        #expect(ChatThread(kept: [kept], role: "planner").turns.first?.attachments == [shot])
        var thread = ChatThread()
        thread.begin(question: "", role: "planner", attachments: [shot])
        #expect(thread.turns.first?.attachments == [shot])
    }
}

#if os(macOS)
import AppKit

/// A paste in the Mac's message box (`Pasted`), on a pasteboard of the test's own.
extension AttachmentsTests {
    @MainActor static func pasted(_ fill: (NSPasteboard) -> Void) -> [(name: String, data: Data)]? {
        let board = NSPasteboard.withUniqueName()
        defer { board.releaseGlobally() }
        board.clearContents()
        fill(board)
        return Pasted.files(from: board, refused: { _ in })
    }

    @MainActor @Test func aPictureCopiedAloneGoesWithTheMessageAndTextIsPastedAsText() throws {
        let png = try Self.picture(width: 40, height: 30, type: .png)
        let alone = try #require(Self.pasted { $0.setData(png, forType: .png) })
        #expect(alone.map { $0.name } == ["Pasted picture.png"] && alone.first?.data == png)
        // A picture some apps copy as a TIFF alone: it goes as a PNG.
        let tiff = try Self.picture(width: 40, height: 30, type: .tiff)
        let converted = try #require(Self.pasted { $0.setData(tiff, forType: .tiff) })
        #expect(Attachments.pictureType(try #require(converted.first).data) == "image/png")
        // With text (a page copied), or text alone, or nothing: pasted as ever, so nothing here.
        let page = NSPasteboardItem()
        page.setString("a page", forType: .string)
        page.setData(png, forType: .png)
        #expect(Self.pasted { $0.writeObjects([page]) } == nil)
        #expect(Self.pasted { $0.setString("hello", forType: .string) } == nil)
        #expect(Self.pasted { _ in } == nil)
    }

    @MainActor @Test func filesCopiedInTheFinderGoAsThemselvesNotAsTheirNames() throws {
        let dir = FileManager.default.temporaryDirectory.appending(path: "invincible-paste-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: dir) }
        let log = dir.appending(path: "test.log")
        try Data("FAIL db.test.ts\n".utf8).write(to: log)
        // The Finder copies a file as its address and its name as text: the file goes.
        let copied = NSPasteboardItem()
        copied.setString(log.absoluteString, forType: .fileURL)
        copied.setString("test.log", forType: .string)
        let files = try #require(Self.pasted { $0.writeObjects([copied]) })
        #expect(files.map { $0.name } == ["test.log"] && files.first?.data == Data("FAIL db.test.ts\n".utf8))
    }
}
#endif
