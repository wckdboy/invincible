import Foundation

/**
 * This device talking to its node. Every /api request is signed with the device key over (method, path, time, nonce,
 * body hash) and sent with exactly those bytes, as the PWA's `signedFetch` does (apps/web/src/api.ts). Nothing is
 * cached, no cookie is kept, and a redirect is never followed: a signed request goes only where it was meant to go.
 */
struct NodeClient: Sendable {
    let origin: URL
    let signer: any RequestSigner
    private let clock: @Sendable () -> Date
    private let nonce: @Sendable () -> String

    init(origin: URL, signer: any RequestSigner, clock: @escaping @Sendable () -> Date = { .now }, nonce: @escaping @Sendable () -> String = { RequestAuth.newNonce() }) {
        self.origin = origin
        self.signer = signer
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

    /// The request, signed. `path` is the path and query, exactly as the node will read them back.
    func request(_ method: String, _ path: String, body: Data?, timeout: TimeInterval = 60) throws -> URLRequest {
        guard path.hasPrefix("/"), let url = URL(string: path, relativeTo: origin)?.absoluteURL else {
            throw NodeError(status: 0, message: "\(path) isn't a path on the node")
        }
        var request = URLRequest(url: url, cachePolicy: .reloadIgnoringLocalAndRemoteCacheData, timeoutInterval: timeout)
        request.httpMethod = method
        let headers = try RequestAuth.headers(signer: signer, method: method, path: path, body: body ?? Data(), ts: RequestAuth.timestamp(clock()), nonce: nonce())
        for (name, value) in headers { request.setValue(value, forHTTPHeaderField: name) }
        request.setValue(TimeZone.current.identifier, forHTTPHeaderField: RequestAuth.Header.zone)
        if let body {
            request.httpBody = body
            request.setValue("application/json", forHTTPHeaderField: "content-type")
        }
        return request
    }

    func get<T: Decodable>(_ path: String, as type: T.Type = T.self) async throws -> T {
        try decode(T.self, from: await send(request("GET", path, body: nil)))
    }

    /// A GET answered as `T`, and the bytes it came in (to keep a part of them: KeptTable).
    func read<T: Decodable>(_ path: String, as type: T.Type = T.self) async throws -> (value: T, bytes: Data) {
        let data = try await send(request("GET", path, body: nil))
        return (try decode(T.self, from: data), data)
    }

    func post<T: Decodable>(_ path: String, _ body: some Encodable, as type: T.Type = T.self) async throws -> T {
        let data = try await send(request("POST", path, body: JSONEncoder().encode(body)))
        if let late = NodeError.late(in: data) { throw late }
        return try decode(T.self, from: data)
    }

    /// A POST answered with bytes (a file of yours kept on the node): the bytes as they are.
    func bytes(_ path: String, _ body: some Encodable) async throws -> Data {
        try await send(request("POST", path, body: JSONEncoder().encode(body)))
    }

    /// A POST answered with server-sent events (the primary's chat): each event as it arrives. Ending the stream (its
    /// consumer goes away) ends the watching and nothing else: a turn the node owns runs on to its end.
    func events(_ path: String, _ body: some Encodable) -> AsyncThrowingStream<ChatEvent, any Error> {
        payloads(path, body, as: ChatEvent.init(json:))
    }

    /// A POST answered with server-sent events, each read as `read` reads it (one it can't read is passed over).
    func payloads<Event: Sendable>(_ path: String, _ body: some Encodable, as read: @escaping @Sendable (String) -> Event?) -> AsyncThrowingStream<Event, any Error> {
        let request = Result { try self.request("POST", path, body: JSONEncoder().encode(body), timeout: 120) }
        return AsyncThrowingStream { continuation in
            let task = Task {
                do {
                    let (bytes, response) = try await Self.session.bytes(for: request.get())
                    let status = (response as? HTTPURLResponse)?.statusCode ?? 0
                    guard (200..<300).contains(status) else {
                        var said = Data()
                        for try await byte in bytes where said.count < 65_536 { said.append(byte) }
                        throw NodeError.from(status: status, headers: Self.headers(of: response), body: said)
                    }
                    var reader = SSEReader()
                    for try await byte in bytes {
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
        do {
            return try JSONDecoder().decode(T.self, from: data)
        } catch {
            throw NodeError(status: 200, message: "The node's answer wasn't what this app reads (\(error.localizedDescription)).")
        }
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
        case ("stopped", let f): self = .stopped(reason: f.reason ?? "")
        case ("error", let f): self = .error(f.error ?? "Something went wrong.")
        case ("done", let f): self = .done(ref: f.ref ?? "")
        default: self = .other(frame.type)
        }
    }
}
