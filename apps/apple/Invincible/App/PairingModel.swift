import Foundation
import Observation

/// Pairing this device, step by step for its screen, as the PWA's pairing page goes (apps/web/src/pair.ts): network
/// trouble retries, and only a definite answer (declined, unverifiable, expired) ends it.
@MainActor @Observable final class PairingModel {
    enum Stage: Equatable {
        /// Paste a link, name this device, ask.
        case entering
        case asking
        /// Asked: the code to compare, and what is happening now.
        case waiting(code: String, note: String)
        case approved
        /// A definite no: a fresh invite is needed.
        case stopped(String)
        /// This device's key is known to the fleet, but the node won't accept it.
        case refusedKey
    }

    var link = ""
    var name = PairingModel.defaultName
    private(set) var stage = Stage.entering
    /// Something said under the form that doesn't end pairing: no answer, or a refusal worth asking again after.
    private(set) var problem: String?
    private var task: Task<Void, Never>?

    /// What a new device is called until you name it (the PWA calls an installed app the same).
    static var defaultName: String { "Invincible app on \(ThisDevice.kind)" }

    var canAsk: Bool { stage == .entering && !link.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && !name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }

    func ask(app: AppModel) {
        guard canAsk else { return }
        problem = nil
        let text = link
        let name = String(name.trimmingCharacters(in: .whitespacesAndNewlines).prefix(64))
        let invite: Invite
        do {
            invite = try Invite.decode(text)
        } catch {
            problem = "That isn't an Invincible invite. Copy the whole link that invincible invite --client printed."
            return
        }
        guard invite.kind == .client else {
            stage = .stopped("This invite is for a machine. Run invincible join … on that machine instead.")
            return
        }
        guard let origin = Joining.origin(for: text, invite: invite) else {
            problem = "That link doesn't say where your node is."
            return
        }
        stage = .asking
        task = Task { await run(app: app, invite: invite, origin: origin, name: name) }
    }

    func cancel() {
        task?.cancel()
        task = nil
        stage = .entering
    }

    func restart() {
        task?.cancel()
        (task, link, problem, stage) = (nil, "", nil, .entering)
    }

    /// The key the fleet knows but won't accept: forget it, so a fresh invite makes a new device.
    func forgetKey(app: AppModel) {
        do {
            try app.forget()
            restart()
        } catch {
            problem = error.localizedDescription
        }
    }

    private func run(app: AppModel, invite: Invite, origin: URL, name: String) async {
        let key: DeviceKey
        do {
            key = try DeviceKey.load() ?? DeviceKey.create()
        } catch {
            (stage, problem) = (.entering, error.localizedDescription)
            return
        }
        let joining = Joining(invite: invite, device: key.device, transport: NodePairTransport(origin: origin))
        let waiting: @Sendable (Bool) -> Void = { [weak self] retrying in
            _ = Task { @MainActor in
                guard let self, case .waiting(let code, _) = self.stage else { return }
                self.stage = .waiting(code: code, note: retrying ? "Connection lost. Retrying…" : "Waiting for your approval…")
            }
        }
        do {
            // Asked already, before the app was closed? Then it waits on; approved meanwhile? Then it's done.
            switch try? await joining.status() {
            case .approved?:
                return await finish(app: app, key: key, origin: origin, invite: invite, name: name)
            case .pending?:
                break
            case nil:
                try await joining.ask(name: name)
            }
            stage = .waiting(code: joining.code, note: "Waiting for your approval…")
            try await joining.approval(onRetry: waiting)
            await finish(app: app, key: key, origin: origin, invite: invite, name: name)
        } catch Joining.Stop.alreadyEnrolled {
            // Approved earlier, then the app went away: a signed request says whether the node takes this key (whoami, the
            // one request a node that hasn't proved itself yet is asked: NodePin).
            if (try? await NodeClient(origin: origin, signer: key).provenWhoami(challenge: NodeProof.challenge()))?.me != nil {
                await finish(app: app, key: key, origin: origin, invite: invite, name: name)
            } else {
                stage = .refusedKey
            }
        } catch Joining.Stop.alreadyUsed {
            // Approved while the app was away? The status proof will tell.
            stage = .waiting(code: joining.code, note: "Checking with your node…")
            do {
                try await joining.approval(onRetry: waiting)
                await finish(app: app, key: key, origin: origin, invite: invite, name: name)
            } catch {
                stopped(error)
            }
        } catch {
            stopped(error)
        }
    }

    private func stopped(_ error: any Error) {
        switch error {
        case is CancellationError: break
        case Joining.Stop.ended(let why): stage = .stopped(why)
        case Joining.Stop.refused(let why), Joining.Stop.unreachable(let why): (stage, problem) = (.entering, why)
        default: (stage, problem) = (.entering, error.localizedDescription)
        }
    }

    private func finish(app: AppModel, key: DeviceKey, origin: URL, invite: Invite, name: String) async {
        // Approved: what the node says this device is, and which node it is, proven: pinned from the pairing, and named in
        // what this device signs from then on (the slice 8 note's item 11). A node from before proves nothing: pinned at
        // the first proof it gives.
        let challenge = NodeProof.challenge()
        let me = try? await NodeClient(origin: origin, signer: key).provenWhoami(challenge: challenge)
        let proven = me.map { NodeProof.judge(pinned: nil, said: $0.said, challenge: challenge, now: .now, check: .app) }
        if proven == .failed {
            stage = .stopped("The node's proof of which node it is didn't hold: this device isn't paired with it.")
            return
        }
        stage = .approved
        link = ""
        try? await Task.sleep(for: .milliseconds(700))
        var paired = PairedNode(origin: origin, device: key.device, name: name, fleet: invite.f, nodeName: me?.me?.nodeName, fleetName: me?.me?.fleetName)
        if case .pin(let id) = proven { paired.nodeId = id }
        app.paired(key: key, node: paired)
    }
}
