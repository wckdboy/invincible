import Foundation
import Observation

/**
 * The files waiting to go with your next message, in your chat with the primary or in an agent's conversation: each made
 * ready as it is added (a picture drawn again, smaller and without its metadata; a PDF read into its words, or its
 * pages drawn), then sent up to the node (`POST /api/uploads`); the message then names them (the PWA's
 * views/attach-tray.ts).
 */
@MainActor @Observable final class Outbox {
    /// A file waiting to go with your next message: going up to the node, up (what the message carries), or not taken.
    struct Waiting: Identifiable, Equatable {
        enum State: Equatable { case going, up, failed(String) }
        let id: Int
        var name: String
        var size: Int
        /// A picture's bytes, to show it (nil: a text, or not read yet).
        var look: Data?
        var state: State
        var ref: AttachmentRef?
    }

    /// In the order you added them.
    private(set) var waiting: [Waiting] = []
    private var key = 0
    /// Why a file you added wasn't taken (said once, then cleared).
    var problem: String?

    /// What your next message carries: the files that are up.
    var carried: [AttachmentRef] { waiting.compactMap(\.ref) }
    /// A file is still going up: the message waits for it.
    var going: Bool { waiting.contains { $0.state == .going } }
    var full: Bool { waiting.count >= Attachments.perMessage }

    /// Files added (from Photos, Files, the camera, a paste, or dropped): each made ready, then sent up.
    func attach(_ files: [(name: String, data: Data)], with client: NodeClient) {
        let room = Attachments.perMessage - waiting.count
        if files.count > room { problem = "\(Attachments.perMessage) files go with a message at most." }
        for (name, data) in files.prefix(max(0, room)) {
            key += 1
            let first = key
            waiting.append(Waiting(id: first, name: name, size: data.count, state: .going))
            Task {
                let ready: [Attachments.Prepared]
                do {
                    ready = try await Task.detached(priority: .userInitiated) { try Attachments.prepareAll(name: name, data: data) }.value
                } catch {
                    // One that can't go leaves the box, and why is said.
                    waiting.removeAll { $0.id == first }
                    problem = (error as? Attachments.Refused)?.errorDescription ?? error.localizedDescription
                    return
                }
                // A PDF of pictures (a scan) is its pages: the first takes its place, the rest follow it, as room allows.
                var keys = [first]
                var after = (waiting.firstIndex { $0.id == first } ?? waiting.count - 1) + 1
                for _ in ready.dropFirst() where waiting.count < Attachments.perMessage {
                    key += 1
                    keys.append(key)
                    waiting.insert(Waiting(id: key, name: "", size: 0, state: .going), at: after)
                    after += 1
                }
                if ready.count > keys.count { problem = "\(Attachments.perMessage) files go with a message at most: its first pages are added." }
                for (file, at) in zip(ready, keys) {
                    change(at) { ($0.name, $0.size, $0.look) = (file.name, file.data.count, file.type == "text/plain" ? nil : file.data) }
                }
                for (file, at) in zip(ready, keys) { await upload(file, key: at, with: client) }
            }
        }
    }

    /// One sent up; one the node refused stays, to remove, saying why.
    private func upload(_ file: Attachments.Prepared, key: Int, with client: NodeClient) async {
        struct Upload: Encodable { let name: String; let type: String; let data: String }
        struct Uploaded: Decodable { let attachment: AttachmentRef }
        do {
            let ref = try await client.post("/api/uploads", Upload(name: file.name, type: file.type, data: file.data.base64EncodedString()), as: Uploaded.self).attachment
            if ref.isPicture { AttachmentLooks.shared.know(ref.id, file.data) }
            change(key) { ($0.ref, $0.state) = (ref, .up) }
        } catch {
            change(key) { $0.state = .failed(error.localizedDescription) }
        }
    }

    func detach(_ id: Int) {
        waiting.removeAll { $0.id == id }
    }

    /// Sent with the message: the box is clear of them (one not taken stays, to remove).
    func sent() {
        waiting.removeAll { $0.state == .up }
    }

    private func change(_ key: Int, _ edit: (inout Waiting) -> Void) {
        guard let at = waiting.firstIndex(where: { $0.id == key }) else { return }
        edit(&waiting[at])
    }
}
