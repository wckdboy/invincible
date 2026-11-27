import Foundation
import Synchronization

/**
 * The node this device speaks to, as that node proved it (NodeProof), shared by every copy of a client and, per pairing, by
 * all that speaks to it in this process (`shared`): what each request signs names (RequestAuth's v2), and whether
 * anything but whoami is sent at all (the slice 8 note's item 11; the review of apps-name-node's rules 1 to 3):
 * - until the node at its address has proved itself here (`proven`), what is asked waits (`ready`), and is signed once
 *   it has, so it names the node the proof pinned;
 * - once it proved to be another, or its proof failed (`refused`), nothing is sent but whoami's proof, asked again, and
 *   only a proof that holds lifts that (`proved`);
 * - a whoami that got no answer that proves anything leaves the refusal as it was, and otherwise is what waits is told
 *   (`unanswered`), until the next look asks again.
 */
final class NodePin: Sendable {
    private struct State: Sendable {
        var node: String?
        var refused: NodeError?
        var proven = false
        var unanswered: NodeError?
        var waiting: [UUID: CheckedContinuation<Void, any Error>] = [:]

        /// What what waits is told now, or nil: it waits on.
        var answer: Result<Void, any Error>? {
            if let refused { return .failure(refused) }
            if proven { return .success(()) }
            if let unanswered { return .failure(unanswered) }
            return nil
        }
    }

    private let state: Mutex<State>

    /// `proven`: no proof is waited for (a client with nothing to prove, as the tests' are).
    init(_ node: String? = nil, proven: Bool = false) { state = Mutex(State(node: node, proven: proven)) }

    /// One pin per pairing in this process (its node's origin and this device), so whatever speaks to the node shares its
    /// proof and its refusal: the session, and a notification's answer (the review of apps-name-node, L3).
    static func shared(origin: URL, device: String, node: String?) -> NodePin {
        pins.withLock { pins in
            let key = "\(origin.absoluteString) \(device)"
            if let pin = pins[key] { return pin }
            let pin = NodePin(node)
            pins[key] = pin
            return pin
        }
    }

    private static let pins = Mutex<[String: NodePin]>([:])

    var node: String? { state.withLock { $0.node } }
    var refused: NodeError? { state.withLock { $0.refused } }
    var proven: Bool { state.withLock { $0.proven } }

    /// Returns once the node has proved itself here, or throws why nothing is sent: it proved to be another, its proof
    /// failed, or the last whoami got no answer that proves anything. Until one of those, waits.
    func ready() async throws {
        let id = UUID()
        try await withTaskCancellationHandler {
            try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, any Error>) in
                let now = state.withLock { state -> Result<Void, any Error>? in
                    if let answer = state.answer { return answer }
                    // (Cancelled before it waits: its handler has run already, and would never find it.)
                    if Task.isCancelled { return .failure(CancellationError()) }
                    state.waiting[id] = continuation
                    return nil
                }
                if let now { continuation.resume(with: now) }
            }
        } onCancel: {
            state.withLock { $0.waiting.removeValue(forKey: id) }?.resume(throwing: CancellationError())
        }
    }

    /// Its first proof held: pinned, and proven.
    func pin(_ node: String) { settle { $0.node = node; $0.proven = true; $0.refused = nil; $0.unanswered = nil } }
    /// Its proof held for the node pinned (or, before the cutoff, a node from before answered with none, unpinned).
    func proved() { settle { $0.proven = true; $0.refused = nil; $0.unanswered = nil } }
    /// It proved to be another, or its proof failed: nothing more is sent but whoami's proof until it proves to be this one.
    func refuse(_ why: NodeError) { settle { $0.refused = why; $0.proven = false } }
    /// Whoami is being asked: what waits waits for its answer (a refusal stays as it is).
    func asking() { state.withLock { if !$0.proven { $0.unanswered = nil } } }
    /// Whoami got no answer that proves anything: what waits is told so, unless the node proved itself before or a refusal
    /// stands, which this changes nothing of.
    func unanswered(_ why: NodeError) { settle { if !$0.proven && $0.refused == nil { $0.unanswered = why } } }

    private func settle(_ change: (inout State) -> Void) {
        let told = state.withLock { state -> [(CheckedContinuation<Void, any Error>, Result<Void, any Error>)] in
            change(&state)
            guard let answer = state.answer else { return [] }
            defer { state.waiting = [:] }
            return state.waiting.values.map { ($0, answer) }
        }
        for (continuation, answer) in told { continuation.resume(with: answer) }
    }
}

/**
 * This device talking to its node. Every /api request is signed with the device key over (method, path, time, nonce,
 * body hash) and the node it is for (`pin`), and sent with exactly those bytes, as the PWA's `signedFetch` does
 * (apps/web/src/api.ts). Nothing is cached, no cookie is kept, and a redirect is never followed: a signed request goes
 * only where it was meant to go.
 */
struct NodeClient: Sendable {
    let origin: URL
    let signer: any RequestSigner
    let pin: NodePin
    private let clock: @Sendable () -> Date
    private let nonce: @Sendable () -> String

    init(origin: URL, signer: any RequestSigner, pin: NodePin = NodePin(), clock: @escaping @Sendable () -> Date = { .now }, nonce: @escaping @Sendable () -> String = { RequestAuth.newNonce() }) {
        self.origin = origin
        self.signer = signer
        self.pin = pin
        self.clock = clock
        self.nonce = nonce
    }

    static let session: URLSession = {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.requestCachePolicy = .reloadIgnoringLocalAndRemoteCacheData
        configuration.urlCache = nil
        configuration.httpShouldSetCookies = false
        return URLSession(configuration: configuration, delegate: NoRedirects(), delegateQueue: nil)
    }()

    /// How long the node lets a project's git work run inside the one request that asked, in seconds (packages/node's
    /// project-git.ts, held to it by the vectors): a clone, then a look at the checkout's git.
    enum ProjectGit {
        static let clonePath = "/api/projects/clone"
        static let cloneSeconds: TimeInterval = 900
        static let lookSeconds: TimeInterval = 60
    }

    /// How long a request waits for the node's answer: a minute, or, where the node holds the request open while it works,
    /// as long as it lets that work run and a minute more. A project's first clone is one: the node clones inside the
    /// request and stops the clone if the request goes, so a clone longer than a minute was cut short (until 27 November
    /// 2026).
    static func wait(for path: String) -> TimeInterval {
        path == ProjectGit.clonePath ? ProjectGit.cloneSeconds + ProjectGit.lookSeconds + 60 : 60
    }

    /// The request, signed. `path` is the path and query, exactly as the node will read them back. It waits `timeout`, else
    /// as long as its path needs (wait(for:)). Signed for the pinned node (`named`; never for whoami's proof), and never
    /// made once a node at this address proved to be another (NodePin.refused), but for whoami's proof (`proving`), which
    /// is how it proves to be this device's again. What sends it waits first for the node's proof (NodePin.ready).
    func request(_ method: String, _ path: String, body: Data?, timeout: TimeInterval? = nil, named: Bool = true, proving: Bool = false) throws -> URLRequest {
        if !proving, let refused = pin.refused { throw refused }
        guard path.hasPrefix("/"), let url = URL(string: path, relativeTo: origin)?.absoluteURL else {
            throw NodeError(status: 0, message: "\(path) isn't a path on the node")
        }
        var request = URLRequest(url: url, cachePolicy: .reloadIgnoringLocalAndRemoteCacheData, timeoutInterval: timeout ?? Self.wait(for: path))
        request.httpMethod = method
        let headers = try RequestAuth.headers(signer: signer, method: method, path: path, body: body ?? Data(), ts: RequestAuth.timestamp(clock()), nonce: nonce(), node: named ? pin.node : nil)
        for (name, value) in headers { request.setValue(value, forHTTPHeaderField: name) }
        request.setValue(TimeZone.current.identifier, forHTTPHeaderField: RequestAuth.Header.zone)
        if let body {
            request.httpBody = body
            request.setValue("application/json", forHTTPHeaderField: "content-type")
        }
        return request
    }

    func get<T: Decodable>(_ path: String, as type: T.Type = T.self) async throws -> T {
        try await pin.ready()
        return try decode(T.self, from: await send(request("GET", path, body: nil)))
    }

    /// Whoami, asked with `challenge`, which the node answers with its proof of which node it is (NodeProof). Signed for
    /// no node, as whoami's always is taken: so another node at this address still says which it is.
    func provenWhoami(challenge: String) async throws -> (said: NodeProof.Said, me: WhoAmI?) {
        let data = try await send(request("GET", "/api/whoami?challenge=\(challenge)", body: nil, named: false, proving: true))
        return (try decode(NodeProof.Said.self, from: data), try? JSONDecoder().decode(WhoAmI.self, from: data))
    }

    /// Whoami, asked with a fresh challenge and judged against the pin (NodeProof.judge, as `now` stands), and the pin set
    /// as the judgement says: pinned (`pin`; whoever keeps the pairing saves it), proven, or refused. An answer that proves
    /// nothing throws, and leaves a refusal as it was (NodePin.unanswered).
    func prove(check: NodeProof.Checker, now: @Sendable () -> Date = { .now }) async throws -> (proven: NodeProof.Proven, me: WhoAmI?) {
        let challenge = NodeProof.challenge()
        pin.asking()
        let answer: (said: NodeProof.Said, me: WhoAmI?)
        do {
            answer = try await provenWhoami(challenge: challenge)
        } catch let error as NodeError {
            pin.unanswered(error)
            throw error
        }
        let proven = NodeProof.judge(pinned: pin.node, said: answer.said, challenge: challenge, now: now(), check: check)
        switch proven {
        case .pin(let id): pin.pin(id)
        case .same, .older: pin.proved()
        case .other(let id): pin.refuse(.notYours(other: id))
        case .failed: pin.refuse(.notYours(other: nil))
        }
        return (proven, answer.me)
    }

    /// A GET answered as `T`, and the bytes it came in (to keep a part of them: KeptTable).
    func read<T: Decodable>(_ path: String, as type: T.Type = T.self) async throws -> (value: T, bytes: Data) {
        try await pin.ready()
        let data = try await send(request("GET", path, body: nil))
        return (try decode(T.self, from: data), data)
    }

    func post<T: Decodable>(_ path: String, _ body: some Encodable, as type: T.Type = T.self) async throws -> T {
        try await pin.ready()
        let data = try await send(request("POST", path, body: JSONEncoder().encode(body)))
        if let late = NodeError.late(in: data) { throw late }
        return try decode(T.self, from: data)
    }

    /// A POST answered with bytes (a file of yours kept on the node): the bytes as they are.
    func bytes(_ path: String, _ body: some Encodable) async throws -> Data {
        try await pin.ready()
        return try await send(request("POST", path, body: JSONEncoder().encode(body)))
    }

    /// A POST answered with server-sent events (the primary's chat): each event as it arrives. Ending the stream (its
    /// consumer goes away) ends the watching and nothing else: a turn the node owns runs on to its end. `alive` is told
    /// of every line that arrives, the node's beats too, so a watch that has gone quiet can be told from one that's slow.
    func events(_ path: String, _ body: some Encodable, alive: (@Sendable () -> Void)? = nil) -> AsyncThrowingStream<ChatEvent, any Error> {
        payloads(path, body, alive: alive, as: ChatEvent.init(json:))
    }

    /// The node's live stream (core's live.ts, GET /api/live): what changed, as it changes, opened again from `since` (the
    /// last cursor the node gave) when there is one. `alive` is told of every line that arrives, its beats too (LiveLink
    /// takes a stream silent for three of them for dead).
    func live(since: String? = nil, alive: @escaping @Sendable () -> Void) -> AsyncThrowingStream<LiveEvent, any Error> {
        stream({ try self.request("GET", Self.livePath(since: since), body: nil, timeout: 120) }, alive: alive, as: LiveEvent.init(json:))
    }

    /// The stream's path, opened again from `since` when it is a cursor (core's livePath): signed over exactly this, path
    /// and query, and sent as it is (a cursor holds nothing a URL escapes).
    static func livePath(since: String?) -> String {
        guard let since, LiveLink.isCursor(since) else { return "/api/live" }
        return "/api/live?since=\(since)"
    }

    /// A POST answered with server-sent events, each read as `read` reads it (one it can't read is passed over).
    func payloads<Event: Sendable>(_ path: String, _ body: some Encodable, alive: (@Sendable () -> Void)? = nil, as read: @escaping @Sendable (String) -> Event?) -> AsyncThrowingStream<Event, any Error> {
        let body = Result { try JSONEncoder().encode(body) }
        return stream({ try self.request("POST", path, body: body.get(), timeout: 120) }, alive: alive, as: read)
    }

    /// An agent's desktop as you watch it (POST /api/team/desktop/stream): its frames, each whole as its last byte comes
    /// (DesktopFrames), at most DesktopStream.behind of them waiting to be decoded (past that it ends with Behind). Ending
    /// the stream (its consumer goes away) ends the watching: the node ends the VM's encoder when its last watcher goes.
    /// The node's beats keep it from timing out while the screen is still.
    func frames(_ path: String, _ body: some Encodable) -> AsyncThrowingStream<DesktopFrame, any Error> {
        let body = Result { try JSONEncoder().encode(body) }
        // (At most DesktopStream.behind frames wait to be decoded: past that the stream ends, and is watched again.)
        let (frames, queue) = DesktopStream.queue()
        let task = Task {
            // (Made once the node has proved itself here, so it names that node: NodePin.ready.)
            var request: Result<URLRequest, any Error> = .failure(CancellationError())
            do {
                try await pin.ready()
                request = Result { try self.request("POST", path, body: body.get(), timeout: 120) }
                let (bytes, response) = try await Self.session.bytes(for: request.get())
                let status = (response as? HTTPURLResponse)?.statusCode ?? 0
                guard (200..<300).contains(status) else {
                    var said = Data()
                    for try await byte in bytes where said.count < 65_536 { said.append(byte) }
                    throw NodeError.from(status: status, headers: Self.headers(of: response), body: said)
                }
                var parser = DesktopFrames()
                for try await byte in bytes {
                    // (Over, by its watcher going or by falling behind: nothing more is read.)
                    if let frame = try parser.push(byte: byte), !DesktopStream.enqueue(frame, on: queue) { return }
                }
                queue.finish()
            } catch {
                queue.finish(throwing: Self.plain(error, host: request))
            }
        }
        queue.onTermination = { _ in task.cancel() }
        return frames
    }

    /// A stream of the node's events, its request made once the node has proved itself here (NodePin.ready), so it names
    /// that node.
    private func stream<Event: Sendable>(_ make: @escaping @Sendable () throws -> URLRequest, alive: (@Sendable () -> Void)?, as read: @escaping @Sendable (String) -> Event?) -> AsyncThrowingStream<Event, any Error> {
        AsyncThrowingStream { continuation in
            let task = Task {
                var request: Result<URLRequest, any Error> = .failure(CancellationError())
                do {
                    try await pin.ready()
                    request = Result { try make() }
                    let (bytes, response) = try await Self.session.bytes(for: request.get())
                    let status = (response as? HTTPURLResponse)?.statusCode ?? 0
                    guard (200..<300).contains(status) else {
                        var said = Data()
                        for try await byte in bytes where said.count < 65_536 { said.append(byte) }
                        throw NodeError.from(status: status, headers: Self.headers(of: response), body: said)
                    }
                    alive?()
                    var reader = SSEReader()
                    for try await byte in bytes {
                        // (Every line, a beat's too: the stream is alive.)
                        if byte == 0x0A { alive?() }
                        for payload in reader.feed(CollectionOfOne(byte)) {
                            if let event = read(payload) { continuation.yield(event) }
                        }
                    }
                    continuation.finish()
                } catch {
                    continuation.finish(throwing: Self.plain(error, host: request))
                }
            }
            continuation.onTermination = { _ in task.cancel() }
        }
    }

    private func send(_ request: URLRequest) async throws -> Data {
        do {
            let (data, response) = try await Self.session.data(for: request)
            let status = (response as? HTTPURLResponse)?.statusCode ?? 0
            guard (200..<300).contains(status) else { throw NodeError.from(status: status, headers: Self.headers(of: response), body: data) }
            return data
        } catch {
            throw Self.plain(error, host: .success(request))
        }
    }

    private func decode<T: Decodable>(_ type: T.Type, from data: Data) throws -> T {
        try Self.decoded(T.self, from: data)
    }

    /// The node's answer as `T`. One whose JSON holds a lone UTF-16 surrogate (a name that wasn't UTF-8, as a node before
    /// the fourth fabric review's R4-5 may have kept it in a notice) is read with each one said as U+FFFD, the replacement
    /// character, as the node now keeps them: JSONDecoder would refuse the whole answer for that one character.
    static func decoded<T: Decodable>(_ type: T.Type, from data: Data) throws -> T {
        do {
            return try JSONDecoder().decode(T.self, from: data)
        } catch {
            let mended = wellFormed(data)
            if mended != data, let value = try? JSONDecoder().decode(T.self, from: mended) { return value }
            throw NodeError(status: 200, message: "The node's answer wasn't what this app reads (\(error.localizedDescription)).")
        }
    }

    /// JSON with each `\uD800`–`\uDFFF` escape that isn't half of a pair (a high one followed by a low one) written as
    /// `\uFFFD`. Every other byte is as it was: an escaped backslash stays one, so `\\udcff` (a backslash, then text) is
    /// never taken for an escape.
    static func wellFormed(_ data: Data) -> Data {
        let bytes = [UInt8](data)
        let slash = UInt8(ascii: "\\"), u = UInt8(ascii: "u")
        func unit(at index: Int) -> UInt16? {
            guard index + 4 <= bytes.count else { return nil }
            return UInt16(String(decoding: bytes[index..<index + 4], as: UTF8.self), radix: 16)
        }
        var out = [UInt8]()
        out.reserveCapacity(bytes.count)
        var index = 0
        while index < bytes.count {
            guard bytes[index] == slash, index + 1 < bytes.count else {
                out.append(bytes[index])
                index += 1
                continue
            }
            if bytes[index + 1] == u, let high = unit(at: index + 2), (0xD800...0xDFFF).contains(high) {
                if (0xD800...0xDBFF).contains(high), index + 12 <= bytes.count, bytes[index + 6] == slash, bytes[index + 7] == u,
                   let low = unit(at: index + 8), (0xDC00...0xDFFF).contains(low) {
                    out.append(contentsOf: bytes[index..<index + 12])
                    index += 12
                } else {
                    out.append(contentsOf: Array("\\ufffd".utf8))
                    index += 6
                }
                continue
            }
            // Any other escape: the backslash and what it escapes, as they were.
            out.append(contentsOf: bytes[index...index + 1])
            index += 2
        }
        return Data(out)
    }

    /// A failure in words: no answer at all becomes a NodeError the app can say; a cancellation stays one.
    private static func plain(_ error: any Error, host request: Result<URLRequest, any Error>) -> any Error {
        guard let failure = error as? URLError else { return error }
        if failure.code == .cancelled { return CancellationError() }
        let host = (try? request.get().url?.host()) ?? "the node"
        return NodeError(status: 0, message: "Can't reach \(host): \(failure.localizedDescription)", unreachable: true)
    }

    private static func headers(of response: URLResponse) -> [String: String] {
        ((response as? HTTPURLResponse)?.allHeaderFields ?? [:]).reduce(into: [:]) { headers, field in
            if let name = field.key as? String, let value = field.value as? String { headers[name.lowercased()] = value }
        }
    }
}

/// A signed request is never sent on somewhere else.
private final class NoRedirects: NSObject, URLSessionTaskDelegate, Sendable {
    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse, newRequest request: URLRequest) async -> URLRequest? {
        nil
    }
}

/// What went wrong, in the node's own words where it said any.
struct NodeError: LocalizedError, Sendable, Equatable {
    /// The HTTP status; 0 when nothing answered.
    let status: Int
    let message: String
    /// The node's clock (its Date header): a device clock a minute off is refused, which isn't a revoked key.
    var serverTime: Date? = nil
    /// Nothing answered, or a proxy answered for a node that's away: try again later; it isn't a refusal.
    var unreachable = false
    /// The node at this address proved to be another than the one this device paired with (its id), or its proof failed
    /// (""): nothing more is sent there (NodePin).
    var notYourNode: String? = nil

    /// The node at this address isn't this device's: it proved to be `other`, or its proof failed (nil).
    static func notYours(other: String?) -> NodeError {
        NodeError(status: 0, message: other.map { "It proved to be another node (\(String($0.dropFirst(2).prefix(8)))), not the one this device paired with." } ?? "Its proof of which node it is didn't hold.", notYourNode: other ?? "")
    }

    var errorDescription: String? { message }

    static func from(status: Int, headers: [String: String], body: Data) -> NodeError {
        let header = { (name: String) in headers.first { $0.key.lowercased() == name }?.value }
        let serverTime = header("date").flatMap(httpDate)
        if [502, 503, 504].contains(status), !(header("content-type") ?? "").contains("application/json") {
            return NodeError(status: status, message: "Invincible's node isn't answering (\(status)). It may be restarting.", serverTime: serverTime, unreachable: true)
        }
        let said = (try? JSONDecoder().decode(Said.self, from: body))?.error
        return NodeError(status: status, message: said ?? "The node answered \(status).", serverTime: serverTime)
    }

    /// A long-running answer has already sent 200 when its work fails, so the failure arrives as exactly `{ error, status }`.
    static func late(in body: Data) -> NodeError? {
        guard let object = try? JSONSerialization.jsonObject(with: body) as? [String: Any], object.count == 2,
              let error = object["error"] as? String, let status = object["status"] as? Int else { return nil }
        return NodeError(status: status, message: error)
    }

    private struct Said: Decodable { let error: String? }

    private static func httpDate(_ text: String) -> Date? {
        let format = DateFormatter()
        format.locale = Locale(identifier: "en_US_POSIX")
        format.timeZone = TimeZone(identifier: "GMT")
        format.dateFormat = "EEE, dd MMM yyyy HH:mm:ss zzz"
        return format.date(from: text)
    }
}

/// Server-sent events as the PWA's `sseData` reads them: a block ends at a blank line, and each `data:` line in it is
/// one payload, its leading whitespace dropped; comments (`: keep-alive`) and other fields are skipped. Bytes are split
/// only at newlines, which no UTF-8 character contains, so a character split across arrivals is read whole.
struct SSEReader {
    private var buffer: [UInt8] = []
    /// Up to here no blank line has been found (a boundary may still straddle the next bytes).
    private var scanned = 1

    mutating func feed(_ bytes: some Sequence<UInt8>) -> [String] {
        buffer.append(contentsOf: bytes)
        var payloads: [String] = []
        var start = 0
        var index = max(scanned, 1)
        while index < buffer.count {
            if buffer[index] == 0x0A, buffer[index - 1] == 0x0A {
                payloads += Self.payloads(in: buffer[start..<(index - 1)])
                start = index + 1
                index = start + 1
            } else {
                index += 1
            }
        }
        if start > 0 { buffer.removeFirst(start) }
        scanned = max(buffer.count, 1)
        return payloads
    }

    private static func payloads(in block: ArraySlice<UInt8>) -> [String] {
        block.split(separator: 0x0A, omittingEmptySubsequences: false).compactMap { line in
            let text = String(decoding: line, as: UTF8.self)
            return text.hasPrefix("data:") ? String(text.dropFirst(5).drop(while: \.isWhitespace)) : nil
        }
    }
}

/// What a chat answer sends as it goes (core's `ChatStreamEvent`), as far as this app reads it; anything else is kept
/// by its type, so a newer node's events pass by harmlessly.
enum ChatEvent: Equatable, Sendable {
    /// First in a turn the node owns: its id, the kept chat it belongs to, the kept message its first answer is, the
    /// role it answers as, and whether what follows first is what already happened (attaching to it later).
    case turn(id: String, conversation: String?, answer: Int?, role: String, replay: Bool)
    /// The kept chat this answer belongs to (first, when it's new).
    case conversation(id: String, title: String)
    case model(String)
    case text(String)
    /// It calls one of its tools: `input` is a short summary of the arguments.
    case tool(id: String, name: String, title: String, input: String)
    case toolResult(id: String, ok: Bool, summary: String)
    /// Archived entries it was given as context for this answer.
    case archive([ArchiveEntry])
    /// A model didn't answer, and the next on the roster was asked.
    case fallback(from: String, error: String)
    /// A message of yours reached it while it worked: what follows answers it, in the same turn.
    case steer(String)
    /// Messages of yours that hadn't reached it when the turn ended: queued first and held in a kept chat, handed back
    /// otherwise.
    case undelivered(texts: [String], queued: Bool)
    /// First in a side question's stream: its id, to bring it back by.
    case aside(id: String)
    case stopped(reason: String)
    case error(String)
    case done(ref: String)
    case other(String)

    struct ArchiveEntry: Decodable, Equatable, Sendable {
        let id: String
        let title: String
        let kind: String
        let trust: String
    }

    init?(json: String) {
        struct Frame: Decodable {
            let type: String
            let id: String?
            let conversation: String?
            let answer: Int?
            let role: String?
            let replay: Bool?
            let title: String?
            let name: String?
            let input: String?
            let ref: String?
            let text: String?
            let ok: Bool?
            let summary: String?
            let entries: [ArchiveEntry]?
            let from: String?
            let reason: String?
            let error: String?
            let texts: [String]?
            let queued: Bool?
        }
        guard let frame = try? JSONDecoder().decode(Frame.self, from: Data(json.utf8)) else { return nil }
        switch (frame.type, frame) {
        case ("turn", let f):
            guard let id = f.id else { return nil }
            self = .turn(id: id, conversation: f.conversation, answer: f.answer, role: f.role ?? "planner", replay: f.replay ?? false)
        case ("conversation", let f): guard let id = f.id else { return nil }; self = .conversation(id: id, title: f.title ?? "")
        case ("model", let f): self = .model(f.ref ?? "")
        case ("text", let f): guard let text = f.text else { return nil }; self = .text(text)
        case ("tool", let f): self = .tool(id: f.id ?? "", name: f.name ?? "", title: f.title ?? "", input: f.input ?? "")
        case ("tool_result", let f): self = .toolResult(id: f.id ?? "", ok: f.ok ?? false, summary: f.summary ?? "")
        case ("archive", let f): self = .archive(f.entries ?? [])
        case ("fallback", let f): self = .fallback(from: f.from ?? "", error: f.error ?? "")
        case ("steer", let f): guard let text = f.text else { return nil }; self = .steer(text)
        case ("undelivered", let f): self = .undelivered(texts: f.texts ?? [], queued: f.queued ?? false)
        case ("aside", let f): guard let id = f.id else { return nil }; self = .aside(id: id)
        case ("stopped", let f): self = .stopped(reason: f.reason ?? "")
        case ("error", let f): self = .error(f.error ?? "Something went wrong.")
        case ("done", let f): self = .done(ref: f.ref ?? "")
        default: self = .other(frame.type)
        }
    }
}
