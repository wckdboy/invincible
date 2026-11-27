import CryptoKit
import Foundation
import Testing
@testable import Invincible

/// What goes to the node and how its answers are read: requests signed over exactly the bytes sent, errors in the
/// node's own words, and server-sent events read as the PWA's `sseData` reads them.
struct NodeClientTests {
    let vectors = Vectors.shared

    func client(origin: String, pin: NodePin = NodePin()) throws -> NodeClient {
        let key = try P256.Signing.PrivateKey(rawRepresentation: #require(Data(hex: vectors.identity.scalarHex)))
        return try NodeClient(origin: #require(URL(string: origin)), signer: FakeSigner(key: key), pin: pin, clock: { Date(timeIntervalSince1970: 1_763_200_000) }, nonce: { "nonce-for-tests1" })
    }

    func verifies(_ request: URLRequest, method: String, path: String, body: Data, node: String? = nil) throws -> Bool {
        let publicKey = try P256.Signing.PublicKey(x963Representation: #require(Data(base64URLEncoded: vectors.identity.publicKey)))
        let headers = request.allHTTPHeaderFields ?? [:]
        let sig = try #require(headers[RequestAuth.Header.sig].flatMap { Data(base64URLEncoded: $0) })
        let input = RequestAuth.signingInput(method: method, path: path, ts: try #require(headers[RequestAuth.Header.ts]), nonce: try #require(headers[RequestAuth.Header.nonce]), body: body, node: node)
        return publicKey.isValidSignature(try P256.Signing.ECDSASignature(rawRepresentation: sig), for: input)
    }

    // The slice 8 note's item 11: what this device signs names the node it proved to be, and never whoami's proof.
    @Test func aPinnedClientSignsEveryRequestForItsNodeAndWhoamisProofForNone() throws {
        let node = vectors.nodeProofs[0].node
        let pin = NodePin()
        let before = try client(origin: "http://127.0.0.1:7778", pin: pin).request("GET", "/api/team", body: nil)
        #expect(try verifies(before, method: "GET", path: "/api/team", body: Data()))
        pin.pin(node)
        // Every copy of the client shares the pin: the one made before signs for the node from now on.
        let pinned = try client(origin: "http://127.0.0.1:7778", pin: pin)
        for request in [try pinned.request("GET", "/api/team", body: nil), try pinned.request("POST", "/api/chat", body: Data("{}".utf8))] {
            let body = request.httpBody ?? Data()
            #expect(try verifies(request, method: request.httpMethod!, path: request.url!.path(), body: body, node: node))
            #expect(try !verifies(request, method: request.httpMethod!, path: request.url!.path(), body: body))
        }
        let whoami = try pinned.request("GET", "/api/whoami?challenge=c2xpY2UtOC1jaGFsbGVuZ2U", body: nil, named: false)
        #expect(try verifies(whoami, method: "GET", path: "/api/whoami?challenge=c2xpY2UtOC1jaGFsbGVuZ2U", body: Data()))
    }

    @Test func aClientWhoseNodeProvedToBeAnotherSendsNothingUntilAskedAgain() throws {
        let pin = NodePin(vectors.nodeProofs[0].node)
        let client = try client(origin: "http://127.0.0.1:7778", pin: pin)
        pin.refuse(.notYours(other: vectors.nodeProofs[0].anotherNode))
        #expect(throws: NodeError.self) { try client.request("GET", "/api/team", body: nil) }
        #expect(throws: NodeError.self) { try client.request("GET", "/api/whoami?challenge=c2xpY2UtOC1jaGFsbGVuZ2U", body: nil, named: false) }
        do {
            _ = try client.request("POST", "/api/chat", body: Data("{}".utf8))
            Issue.record("a request was made for a node that proved to be another")
        } catch let error as NodeError {
            #expect(error.notYourNode == vectors.nodeProofs[0].anotherNode)
            #expect(error.message == "It proved to be another node (\(vectors.nodeProofs[0].anotherNode.dropFirst(2).prefix(8))), not the one this device paired with.")
        }
        #expect(NodeError.notYours(other: nil).notYourNode == "")
        // Whoami's proof alone is still asked (Try again), and only a proof that holds lifts the refusal.
        #expect(try verifies(client.request("GET", "/api/whoami?challenge=c2xpY2UtOC1jaGFsbGVuZ2U", body: nil, named: false, proving: true), method: "GET", path: "/api/whoami?challenge=c2xpY2UtOC1jaGFsbGVuZ2U", body: Data()))
        pin.unanswered(NodeError(status: 401, message: "unknown device"))
        #expect(pin.refused?.notYourNode == vectors.nodeProofs[0].anotherNode)
        pin.proved()
        #expect(try verifies(client.request("GET", "/api/team", body: nil), method: "GET", path: "/api/team", body: Data(), node: vectors.nodeProofs[0].node))
    }

    // The review of apps-name-node, rules 1 to 3: what is asked waits for the node's proof, here, and is told what came of it.
    @Test func whatIsAskedWaitsForTheNodesProofAndIsToldWhatCameOfIt() async throws {
        let node = vectors.nodeProofs[0].node
        // Waiting, then proven: it goes.
        let pin = NodePin(node)
        let waiting = Task { try await pin.ready() }
        try await Task.sleep(for: .milliseconds(20))
        pin.proved()
        try await waiting.value
        // Refused: told at once, and an answer that proves nothing changes nothing of it.
        pin.refuse(.notYours(other: vectors.nodeProofs[0].anotherNode))
        await #expect(throws: NodeError.self) { try await pin.ready() }
        pin.unanswered(NodeError(status: 0, message: "Can't reach it", unreachable: true))
        #expect(pin.refused?.notYourNode == vectors.nodeProofs[0].anotherNode)
        // A whoami that got no answer that proves anything: what waits is told so; asked again, it waits for that answer.
        let fresh = NodePin()
        let told = Task { try await fresh.ready() }
        try await Task.sleep(for: .milliseconds(20))
        fresh.unanswered(NodeError(status: 401, message: "unknown device"))
        do {
            try await told.value
            Issue.record("a request went before its node proved itself")
        } catch let error as NodeError {
            #expect(error.status == 401)
        }
        fresh.asking()
        let again = Task { try await fresh.ready() }
        try await Task.sleep(for: .milliseconds(20))
        fresh.pin(node)
        try await again.value
        #expect(fresh.node == node && fresh.proven && fresh.refused == nil)
        // Once proven, a later whoami that goes unanswered takes nothing back.
        fresh.unanswered(NodeError(status: 0, message: "Can't reach it", unreachable: true))
        try await fresh.ready()
        // What stops waiting stops: cancelled before or while it waits.
        let cancelled = Task { try await NodePin().ready() }
        cancelled.cancel()
        await #expect(throws: CancellationError.self) { try await cancelled.value }
        // One pin per pairing in this process: the session's and a notification's are the same.
        let origin = try #require(URL(string: "http://127.0.0.1:47121"))
        #expect(NodePin.shared(origin: origin, device: "c_tests-shared-pin", node: nil) === NodePin.shared(origin: origin, device: "c_tests-shared-pin", node: node))
        #expect(NodePin.shared(origin: origin, device: "c_tests-shared-pin", node: nil) !== NodePin.shared(origin: origin, device: "c_tests-another-device", node: nil))
    }

    @Test func aCloneIsWaitedForAsLongAsTheNodeLetsItRun() throws {
        // The node clones a project's repository inside the request that asked, for as long as its CLONE_TIMEOUT lets it,
        // then looks at the checkout's git (GIT_TIMEOUT), and stops the clone if the request goes: the app waits that long
        // for the answer, not the minute anything else gets (before 27 November 2026 a clone past a minute was cut short).
        let node = vectors.projectGit
        let clone = try client(origin: "http://127.0.0.1:7778").request("POST", "/api/projects/clone", body: Data(#"{"id":"site"}"#.utf8))
        #expect(clone.timeoutInterval > node.cloneTimeoutS + node.gitTimeoutS, "the app gives up on a clone after \(clone.timeoutInterval) s")
        let commit = try client(origin: "http://127.0.0.1:7778").request("POST", "/api/projects/commit", body: Data(#"{"id":"site","message":"Fix"}"#.utf8))
        #expect(commit.timeoutInterval == 60)
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

    @Test func theLiveStreamOpenedAgainFromACursorIsSignedOverItsPathAndQueryAsSent() throws {
        let path = NodeClient.livePath(since: "b00t-_.42")
        #expect(path == "/api/live?since=b00t-_.42")
        let request = try client(origin: "http://127.0.0.1:7778").request("GET", path, body: nil)
        #expect(request.url?.absoluteString == "http://127.0.0.1:7778/api/live?since=b00t-_.42")
        #expect(try verifies(request, method: "GET", path: path, body: Data()))
        #expect(try !verifies(request, method: "GET", path: "/api/live", body: Data()))
        // One that isn't a cursor is never sent: the stream is opened afresh.
        #expect(NodeClient.livePath(since: "b00t 42") == "/api/live")
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
