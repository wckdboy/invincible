import CryptoKit
import Foundation
import Network
import Testing
@testable import Invincible

/// What a session does as its node answers whoami, against a node on this machine's loopback (LocalNode): a refusal
/// stands until a proof holds (the re-check of apps-name-node, R1).
@MainActor @Suite(.serialized) struct SessionProofTests {
    func session(at node: LocalNode, pinned: String?, tag: String) throws -> Session {
        let key = try DeviceKey.create(tag: tag)
        return Session(key: key, node: PairedNode(origin: node.origin, device: key.device, name: "tests", fleet: "f_tests", nodeId: pinned))
    }

    // R1 (rule 2): an answer that gives no proof at all (a node from before, judged so only unpinned and before the cutoff)
    // proves nothing, so a refusal that stands, stands; only a proof that holds lifts it.
    @Test func anAnswerWithNoProofLiftsNoRefusal() async throws {
        let node = try await LocalNode(.failed)
        defer { node.stop() }
        let tag = "sh.invincible.bot.tests.proof.r1"
        defer { try? DeviceKey.delete(tag: tag) }
        let key = try DeviceKey.create(tag: tag)
        let before: @Sendable () -> Date = { RequestAuth.namedFrom.addingTimeInterval(-60) }
        let pin = NodePin()
        let client = NodeClient(origin: node.origin, signer: key, pin: pin)
        #expect(try await client.prove(check: .app, now: before).proven == .failed)
        #expect(pin.refused?.notYourNode == "")
        node.mode = .older
        #expect(try await client.prove(check: .app, now: before).proven == .older)
        #expect(pin.refused?.notYourNode == "", "an answer with no proof lifted the refusal")
        #expect(!pin.proven)
        node.mode = .a
        #expect(try await client.prove(check: .app, now: before).proven == .pin(node.a))
        #expect(pin.refused == nil && pin.proven && pin.node == node.a)
        // With no refusal standing, a node from before is spoken to as before: unpinned, and nothing held back.
        let fresh = NodePin()
        node.mode = .older
        #expect(try await NodeClient(origin: node.origin, signer: key, pin: fresh).prove(check: .app, now: before).proven == .older)
        #expect(fresh.proven && fresh.refused == nil && fresh.node == nil)
    }

    // R1 at the session: Try again answered with no proof keeps the refusal and what it says, and asks nothing but whoami.
    // (From the cutoff an answer with no proof fails, so the refusal stands then too.)
    @Test func tryAgainAnsweredWithNoProofKeepsTheRefusal() async throws {
        let node = try await LocalNode(.failed)
        defer { node.stop() }
        let tag = "sh.invincible.bot.tests.proof.r1-session"
        defer { try? DeviceKey.delete(tag: tag) }
        let session = try session(at: node, pinned: nil, tag: tag)
        await session.refresh()
        #expect(session.client.pin.refused?.notYourNode == "")
        #expect(session.trouble?.notYourNode == "")
        node.mode = .older
        _ = node.asked()
        await session.refresh()
        #expect(session.client.pin.refused?.notYourNode == "")
        #expect(session.trouble?.notYourNode == "")
        #expect(session.whoami == nil)
        let asked = node.asked()
        #expect(!asked.isEmpty && asked.allSatisfy { $0.path.hasPrefix("/api/whoami") }, "Try again asked \(asked.map(\.path))")
    }
}

/// A node on this machine's loopback for the session's tests: whoami answered as node A or node B, each proving itself,
/// with a proof that fails, or with none (a node from before); the live stream opened with its hello and held open;
/// anything else a 404. What was asked is noted, and when. It holds nothing but two throwaway keys.
final class LocalNode: @unchecked Sendable {
    enum Mode: Sendable { case a, b, failed, older }
    struct Asked: Sendable {
        let at: Date
        let method: String
        let path: String
    }
    private struct NoPort: Error {}

    let a: String
    let b: String
    let origin: URL
    private let signingA: Curve25519.Signing.PrivateKey
    private let signingB: Curve25519.Signing.PrivateKey
    private let listener: NWListener
    private let queue: DispatchQueue
    private let lock = NSLock()
    private var current: Mode
    private var log: [Asked] = []
    private var streams: [NWConnection] = []

    /// Who a connection is handed to, once the node is made.
    private final class Box: @unchecked Sendable { weak var node: LocalNode? }

    init(_ mode: Mode) async throws {
        let signingA = Curve25519.Signing.PrivateKey()
        let signingB = Curve25519.Signing.PrivateKey()
        let parameters = NWParameters.tcp
        parameters.requiredLocalEndpoint = .hostPort(host: .ipv4(.loopback), port: .any)
        let listener = try NWListener(using: parameters)
        let queue = DispatchQueue(label: "sh.invincible.bot.tests.local-node")
        let box = Box()
        listener.newConnectionHandler = { connection in box.node?.serve(connection) }
        let port = try await Self.start(listener, on: queue)
        self.signingA = signingA
        self.signingB = signingB
        a = Self.id(signingA)
        b = Self.id(signingB)
        self.listener = listener
        self.queue = queue
        current = mode
        origin = URL(string: "http://127.0.0.1:\(port)")!
        box.node = self
    }

    /// How it answers whoami from now on.
    var mode: Mode {
        get { lock.withLock { current } }
        set { lock.withLock { current = newValue } }
    }

    /// What was asked since this was last asked.
    func asked() -> [Asked] {
        lock.withLock {
            let asked = log
            log = []
            return asked
        }
    }

    /// What was asked since `asked()` was, kept.
    func seen() -> [Asked] { lock.withLock { log } }

    func stop() {
        listener.cancel()
        for stream in lock.withLock({ streams }) { stream.cancel() }
    }

    private static func start(_ listener: NWListener, on queue: DispatchQueue) async throws -> UInt16 {
        let told = NSLock()
        nonisolated(unsafe) var done = false
        return try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<UInt16, any Error>) in
            listener.stateUpdateHandler = { state in
                let answer: Result<UInt16, any Error>
                switch state {
                case .ready: answer = listener.port.map { .success($0.rawValue) } ?? .failure(NoPort())
                case .failed(let error): answer = .failure(error)
                default: return
                }
                let first = told.withLock {
                    defer { done = true }
                    return !done
                }
                if first { continuation.resume(with: answer) }
            }
            listener.start(queue: queue)
        }
    }

    private static func id(_ key: Curve25519.Signing.PrivateKey) -> String { "n_" + key.publicKey.rawRepresentation.base64URLEncodedString() }

    private static func proof(_ key: Curve25519.Signing.PrivateKey, _ challenge: String) -> String {
        ((try? key.signature(for: NodeProof.signingInput(challenge))) ?? Data()).base64URLEncodedString()
    }

    private func serve(_ connection: NWConnection) {
        connection.start(queue: queue)
        read(connection, had: Data())
    }

    /// The request's head (a GET's whole), then the answer.
    private func read(_ connection: NWConnection, had: Data) {
        connection.receive(minimumIncompleteLength: 1, maximumLength: 65_536) { [weak self] data, _, complete, error in
            guard let self else { return connection.cancel() }
            var head = had
            if let data { head.append(data) }
            if let end = head.range(of: Data("\r\n\r\n".utf8)) {
                self.answer(connection, String(decoding: head[..<end.lowerBound], as: UTF8.self))
            } else if complete || error != nil || head.count > 65_536 {
                connection.cancel()
            } else {
                self.read(connection, had: head)
            }
        }
    }

    private func answer(_ connection: NWConnection, _ head: String) {
        let words = (head.components(separatedBy: "\r\n").first ?? "").split(separator: " ").map(String.init)
        let method = words.first ?? "", path = words.count > 1 ? words[1] : ""
        let mode = lock.withLock {
            log.append(Asked(at: .now, method: method, path: path))
            return current
        }
        if path.hasPrefix("/api/whoami") {
            send(connection, status: 200, body: whoami(path, mode))
        } else if path.hasPrefix("/api/live") {
            stream(connection)
        } else {
            send(connection, status: 404, body: Data(#"{"error":"not here"}"#.utf8))
        }
    }

    private func whoami(_ path: String, _ mode: Mode) -> Data {
        let challenge = URLComponents(string: path)?.queryItems?.first { $0.name == "challenge" }?.value ?? ""
        let key = mode == .b ? signingB : signingA
        var said: [String: Any] = ["device": "c_tests", "kind": "client", "scopes": ["mind:read"], "node": Self.id(key), "nodeName": mode == .b ? "B" : "A", "fleet": "f_tests", "fleetName": "tests", "primaryName": "Invincible"]
        switch mode {
        case .a, .b: said["proof"] = Self.proof(key, challenge)
        case .failed: said["proof"] = Self.proof(signingA, "another-challenge-entirely")
        case .older: break
        }
        return (try? JSONSerialization.data(withJSONObject: said)) ?? Data()
    }

    private func send(_ connection: NWConnection, status: Int, body: Data) {
        var response = Data("HTTP/1.1 \(status) \(status == 200 ? "OK" : "Not Found")\r\ncontent-type: application/json\r\ncontent-length: \(body.count)\r\nconnection: close\r\n\r\n".utf8)
        response.append(body)
        connection.send(content: response, contentContext: .finalMessage, isComplete: true, completion: .contentProcessed { _ in connection.cancel() })
    }

    /// The live stream: its hello (a beat of 15 s, so it is never taken for silent here), then held open until stop().
    private func stream(_ connection: NWConnection) {
        lock.withLock { streams.append(connection) }
        let hello = Data("data: {\"type\":\"hello\",\"topics\":[\"fleet\"],\"beat\":15000}\n\n".utf8)
        var response = Data("HTTP/1.1 200 OK\r\ncontent-type: text/event-stream\r\ntransfer-encoding: chunked\r\n\r\n".utf8)
        response.append(Data("\(String(hello.count, radix: 16))\r\n".utf8) + hello + Data("\r\n".utf8))
        connection.send(content: response, completion: .contentProcessed { _ in })
    }
}
