import CryptoKit
import Foundation
import Testing
@testable import Invincible

/// What goes to the node and how its answers are read: requests signed over exactly the bytes sent, errors in the
/// node's own words, and server-sent events read as the PWA's `sseData` reads them.
struct NodeClientTests {
    let vectors = Vectors.shared

    func client(origin: String) throws -> NodeClient {
        let key = try P256.Signing.PrivateKey(rawRepresentation: #require(Data(hex: vectors.identity.scalarHex)))
        return try NodeClient(origin: #require(URL(string: origin)), signer: FakeSigner(key: key), clock: { Date(timeIntervalSince1970: 1_763_200_000) }, nonce: { "nonce-for-tests1" })
    }

    func verifies(_ request: URLRequest, method: String, path: String, body: Data) throws -> Bool {
        let publicKey = try P256.Signing.PublicKey(x963Representation: #require(Data(base64URLEncoded: vectors.identity.publicKey)))
        let headers = request.allHTTPHeaderFields ?? [:]
        let sig = try #require(headers[RequestAuth.Header.sig].flatMap { Data(base64URLEncoded: $0) })
        let input = RequestAuth.signingInput(method: method, path: path, ts: try #require(headers[RequestAuth.Header.ts]), nonce: try #require(headers[RequestAuth.Header.nonce]), body: body)
        return publicKey.isValidSignature(try P256.Signing.ECDSASignature(rawRepresentation: sig), for: input)
    }

    @Test func aGetIsSignedOverItsPathAndQueryWithNoBody() throws {
        let request = try client(origin: "http://127.0.0.1:7778").request("GET", "/api/team?probe=1", body: nil)
        #expect(request.url?.absoluteString == "http://127.0.0.1:7778/api/team?probe=1")
        #expect(request.httpMethod == "GET")
        #expect(request.httpBody == nil)
        #expect(request.value(forHTTPHeaderField: "content-type") == nil)
        #expect(request.value(forHTTPHeaderField: RequestAuth.Header.device) == vectors.identity.device)
        #expect(request.value(forHTTPHeaderField: RequestAuth.Header.ts) == "1763200000000")
        #expect(request.value(forHTTPHeaderField: RequestAuth.Header.nonce) == "nonce-for-tests1")
        #expect(try verifies(request, method: "GET", path: "/api/team?probe=1", body: Data()))
        #expect(request.cachePolicy == .reloadIgnoringLocalAndRemoteCacheData)
    }

    @Test func aPostIsSignedOverExactlyTheBytesItSends() throws {
        let body = Data(#"{"role":"planner","messages":[{"role":"user","content":"Hvad så? 🛡️"}]}"#.utf8)
        let request = try client(origin: "https://keep.example.test/").request("POST", "/api/chat", body: body)
        #expect(request.url?.absoluteString == "https://keep.example.test/api/chat")
        #expect(request.httpBody == body)
        #expect(request.value(forHTTPHeaderField: "content-type") == "application/json")
        #expect(try verifies(request, method: "POST", path: "/api/chat", body: body))
        #expect(try !verifies(request, method: "POST", path: "/api/chat", body: body + Data(" ".utf8)))
        // This device's time zone goes beside the signature: the time it says it is in an answer to you.
        #expect(request.value(forHTTPHeaderField: RequestAuth.Header.zone) == TimeZone.current.identifier)
    }

    @Test func theNodesErrorsAreSaidInItsOwnWords() {
        let json = ["content-type": "application/json"]
        #expect(NodeError.from(status: 401, headers: json, body: Data(#"{"error":"sign the request with an enrolled device key"}"#.utf8)).message == "sign the request with an enrolled device key")
        #expect(NodeError.from(status: 403, headers: json, body: Data(#"{"error":"requires scope fleet:admin"}"#.utf8)).status == 403)
        #expect(NodeError.from(status: 500, headers: json, body: Data("{}".utf8)).message == "The node answered 500.")
        // A gateway error that isn't the node's own (the node always answers in JSON): the proxy in front of it.
        let proxy = NodeError.from(status: 502, headers: ["content-type": "text/html"], body: Data("<html>Bad Gateway</html>".utf8))
        #expect(proxy.message == "Invincible's node isn't answering (502). It may be restarting.")
        #expect(proxy.unreachable)
        let dated = NodeError.from(status: 401, headers: json.merging(["date": "Sat, 15 Nov 2025 10:00:00 GMT"]) { $1 }, body: Data())
        #expect(dated.serverTime == Date(timeIntervalSince1970: 1_763_200_800))
    }

    @Test func aLongRunningAnswersLateFailureIsAnError() {
        #expect(NodeError.late(in: Data(#"{"error":"the sandbox couldn't start","status":424}"#.utf8))?.status == 424)
        #expect(NodeError.late(in: Data(#"{"error":"x","status":424,"more":1}"#.utf8)) == nil)
        #expect(NodeError.late(in: Data(#"{"ok":true}"#.utf8)) == nil)
    }

    @Test func serverSentEventsAreReadAsThePWAReadsThem() {
        let stream = Data("data: {\"type\":\"text\",\"text\":\"Hel\"}\n\n: keep-alive\n\ndata: {\"type\":\"text\",\"text\":\"lo 🛡️\"}\n\ndata:{\"type\":\"done\",\"ref\":\"m\"}\n\ndata: unfinished".utf8)
        let expected = [#"{"type":"text","text":"Hel"}"#, #"{"type":"text","text":"lo 🛡️"}"#, #"{"type":"done","ref":"m"}"#]
        var whole = SSEReader()
        #expect(whole.feed(stream) == expected)
        // Arriving a byte at a time, split anywhere (inside the shield too), it reads the same.
        var bytewise = SSEReader()
        #expect(stream.flatMap { bytewise.feed(CollectionOfOne($0)) } == expected)
        var twoLines = SSEReader()
        #expect(twoLines.feed(Data("event: x\ndata: one\ndata:  two\n\n".utf8)) == ["one", "two"])
    }

    @Test func chatEventsAreReadByTheirTypeAndUnknownOnesKept() {
        #expect(ChatEvent(json: #"{"type":"turn","id":"tn_1","conversation":null,"answer":null,"role":"planner","startedAt":1,"deadline":2,"replay":false}"#) == .turn(id: "tn_1", conversation: nil, answer: nil, role: "planner", replay: false))
        #expect(ChatEvent(json: #"{"type":"turn","id":"tn_2","conversation":"cv_1","answer":7,"role":"engineer","startedAt":1,"deadline":2,"replay":true}"#) == .turn(id: "tn_2", conversation: "cv_1", answer: 7, role: "engineer", replay: true))
        #expect(ChatEvent(json: #"{"type":"conversation","id":"cv_1","title":"Hello","project":null}"#) == .conversation(id: "cv_1", title: "Hello"))
        #expect(ChatEvent(json: #"{"type":"model","ref":"stand-in/planner"}"#) == .model("stand-in/planner"))
        #expect(ChatEvent(json: #"{"type":"text","text":"Hi"}"#) == .text("Hi"))
        #expect(ChatEvent(json: #"{"type":"tool","id":"t1","name":"recall","title":"Searching memory","input":"q"}"#) == .tool(id: "t1", name: "recall", title: "Searching memory", input: "q"))
        #expect(ChatEvent(json: #"{"type":"tool_result","id":"t1","name":"recall","ok":false,"summary":"nothing"}"#) == .toolResult(id: "t1", ok: false, summary: "nothing"))
        #expect(ChatEvent(json: #"{"type":"archive","entries":[{"id":"ar_1","title":"Notes","kind":"note","trust":"trusted"}]}"#) == .archive([.init(id: "ar_1", title: "Notes", kind: "note", trust: "trusted")]))
        #expect(ChatEvent(json: #"{"type":"fallback","from":"a/b","error":"429"}"#) == .fallback(from: "a/b", error: "429"))
        #expect(ChatEvent(json: #"{"type":"steer","text":"Skip it"}"#) == .steer("Skip it"))
        #expect(ChatEvent(json: #"{"type":"stopped","reason":"you"}"#) == .stopped(reason: "you"))
        #expect(ChatEvent(json: #"{"type":"error","error":"no model"}"#) == .error("no model"))
        #expect(ChatEvent(json: #"{"type":"done","ref":"x"}"#) == .done(ref: "x"))
        #expect(ChatEvent(json: #"{"type":"usage","ref":"x","usage":null}"#) == .other("usage"))
        #expect(ChatEvent(json: "not json") == nil)
    }
}
