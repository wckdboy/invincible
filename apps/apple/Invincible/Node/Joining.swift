import Foundation

/// The two pairing endpoints, which take no signature: the invite's proof is the credential.
protocol PairTransport: Sendable {
    /// POSTs `body` as JSON; nothing answering at all throws `Joining.Stop.unreachable`.
    func post(_ path: String, _ body: [String: String]) async throws -> (status: Int, body: Data)
}

/**
 * This device joining a fleet with one invite, as the PWA's pairing page does it (apps/web/src/pair.ts) and the joining
 * client in packages/link/src/client.ts: prove it holds the invite, show the code derived from (secret, fleet, its own
 * key), wait for your approval on the node, and trust that approval only with the proof that only the invite's holder
 * can make. The secret never leaves this device.
 */
struct Joining: Sendable {
    enum Answer: Equatable, Sendable { case pending, approved }

    /// Why joining stopped, and what that means for what comes next.
    enum Stop: LocalizedError, Equatable, Sendable {
        /// A definite no: this invite is done with; a fresh one is needed.
        case ended(String)
        /// Refused as asked; asking again may do.
        case refused(String)
        /// This key is enrolled already (approved earlier, then the app was closed): a signed request will tell.
        case alreadyEnrolled
        /// Approved while the app was away, or not: the status proof will tell.
        case alreadyUsed
        /// No answer. Nothing is lost: the invite still holds.
        case unreachable(String)

        var errorDescription: String? {
            switch self {
            case .ended(let why), .refused(let why), .unreachable(let why): why
            case .alreadyEnrolled: "This device is already in the fleet."
            case .alreadyUsed: "This invite was already used."
            }
        }
    }

    let invite: Invite
    let device: String
    let transport: any PairTransport

    /// The six-digit code this device shows, which the node shows too when the invite reached it untouched.
    var code: String { PairingMath.sas(secret: invite.secret, fleet: invite.f, device: device) }

    /// Step 1: ask to join. The node's code must be this device's own, or joining stops here.
    func ask(name: String) async throws {
        let fields = PairRequestFields(invite: invite.i, device: device, name: name, kind: .client)
        var body = fields.object
        body["proof"] = PairingMath.requestProof(secret: invite.secret, fields: fields)
        let (status, data) = try await transport.post("/link/pair/request", body)
        guard status == 200 else {
            let said = Self.said(status, data)
            if status == 409, said.contains("already enrolled") { throw Stop.alreadyEnrolled }
            if status == 409, said.contains("already used") { throw Stop.alreadyUsed }
            throw Self.stop(status, said)
        }
        struct Pending: Decodable { let sas: String }
        guard (try? JSONDecoder().decode(Pending.self, from: data))?.sas == code else {
            throw Stop.ended("The node computed a different code. Stopping here, to be safe.")
        }
    }

    /// Step 2: the node's answer now. An approval counts only with its proof, and only for the invite's fleet.
    func status() async throws -> Answer {
        let proof = PairingMath.statusProof(secret: invite.secret, invite: invite.i, device: device)
        let (status, data) = try await transport.post("/link/pair/status", ["invite": invite.i, "device": device, "proof": proof])
        guard status == 200 else { throw Self.stop(status, Self.said(status, data)) }
        struct Status: Decodable { let status: String; let fleet: String?; let approval: String? }
        let answer = try? JSONDecoder().decode(Status.self, from: data)
        switch answer?.status {
        case "rejected":
            throw Stop.ended("The pairing was declined on the node.")
        case "approved":
            let expected = PairingMath.approvalProof(secret: invite.secret, invite: invite.i, device: device, fleet: invite.f)
            guard answer?.fleet == invite.f, let approval = answer?.approval, PairingMath.proofMatches(expected, approval) else {
                throw Stop.ended("The approval could not be verified. Stopping here, to be safe.")
            }
            return .approved
        default:
            return .pending
        }
    }

    /// Waits for your answer on the node: asks again every 1.5 s, and rides out a lost connection, waiting longer each
    /// time (1.5 s × 2ⁿ, at most 10 s). `onRetry` says whether the last ask went unanswered.
    func approval(sleep: @Sendable (Duration) async throws -> Void = { try await Task.sleep(for: $0) }, onRetry: @Sendable (Bool) -> Void = { _ in }) async throws {
        var failures = 0
        while true {
            do {
                if try await status() == .approved { return }
                failures = 0
                onRetry(false)
                try await sleep(.milliseconds(1500))
            } catch Stop.unreachable {
                failures += 1
                onRetry(true)
                try await sleep(.milliseconds(min(10_000, 1500 << min(failures, 3))))
            }
        }
    }

    /// Where the pairing requests go: the address the link was made for (where the PWA would have been opened), or, for a
    /// bare invite, the inviting node's own endpoint. Nil when that isn't an http(s) address.
    static func origin(for text: String, invite: Invite) -> URL? {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        let link = trimmed.hasPrefix("gi1.") ? invite.e : trimmed
        guard var parts = URLComponents(string: link), let scheme = parts.scheme?.lowercased(), ["http", "https"].contains(scheme), parts.host?.isEmpty == false else { return nil }
        (parts.path, parts.query, parts.fragment, parts.user, parts.password) = ("", nil, nil, nil, nil)
        return parts.url
    }

    /// What an `invincible:` link hands this device to join with (the Mac app opens them): the invite link it carries
    /// (`invincible:https://keep.example.test/#pair=gi1.…`), whose address is where the node is, as when it is pasted; or
    /// the invite alone (`invincible://pair#pair=gi1.…`, `invincible:gi1.…`), whose node is where the invite says. Nil for any
    /// other link, and for one that carries no invite.
    static func handed(_ url: URL) -> String? {
        guard url.scheme?.lowercased() == "invincible" else { return nil }
        let rest = String(url.absoluteString.drop { $0 != ":" }.dropFirst())
        if let carried = URLComponents(string: rest)?.scheme?.lowercased(), ["http", "https"].contains(carried) {
            return (try? Invite.decode(rest)) != nil ? rest : nil
        }
        let token = rest.firstMatch(of: #/[#&?]pair=([A-Za-z0-9._-]+)/#).map { String($0.1) } ?? String(rest.drop { $0 == "/" })
        return (try? Invite.decode(token)) != nil ? token : nil
    }

    private static func said(_ status: Int, _ data: Data) -> String {
        struct Said: Decodable { let error: String? }
        return (try? JSONDecoder().decode(Said.self, from: data))?.error ?? "The node answered \(status)."
    }

    private static func stop(_ status: Int, _ said: String) -> Stop {
        switch status {
        case 404, 403: .ended("This invite has expired or is no longer valid.")
        case 409: .ended(said)
        case 502, 503, 504: .unreachable("Invincible's node isn't answering (\(status)). It may be restarting.")
        case 500...: .unreachable(said)
        default: .refused(said)
        }
    }
}

/// The pairing endpoints over HTTP, at the address the invite came for. Never waits forever: a stalled connection (the
/// tailnet reconnecting, a phone changing networks) becomes `unreachable` after 12 s, as the PWA's does.
struct NodePairTransport: PairTransport {
    let origin: URL

    func post(_ path: String, _ body: [String: String]) async throws -> (status: Int, body: Data) {
        guard let url = URL(string: path, relativeTo: origin)?.absoluteURL else { throw Joining.Stop.refused("\(path) isn't a path on the node") }
        var request = URLRequest(url: url, cachePolicy: .reloadIgnoringLocalAndRemoteCacheData, timeoutInterval: 12)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "content-type")
        request.httpBody = try JSONEncoder().encode(body)
        let host = origin.host() ?? "the node"
        do {
            let (data, response) = try await NodeClient.session.data(for: request)
            let status = (response as? HTTPURLResponse)?.statusCode ?? 0
            let json = ((response as? HTTPURLResponse)?.value(forHTTPHeaderField: "content-type") ?? "").contains("application/json")
            // `tailscale serve` answering for a node that's away: the node isn't refusing.
            if [502, 503, 504].contains(status), !json { throw Joining.Stop.unreachable("Invincible's node isn't answering (\(status)). It may be restarting.") }
            return (status, data)
        } catch let error as URLError {
            if error.code == .cancelled { throw CancellationError() }
            throw Joining.Stop.unreachable(error.code == .timedOut ? "No answer from \(host) within 12 s." : "Can't reach \(host).")
        }
    }
}
