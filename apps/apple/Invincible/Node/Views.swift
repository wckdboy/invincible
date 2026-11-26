import Foundation

/*
 * What the node answers, as far as this app reads it (`packages/core/src/api.ts`, `team.ts` and `turns.ts`). Fields a
 * newer node adds are passed over; a time is milliseconds since 1970 unless it says it is an HLC.
 */

/// `GET /api/whoami`: this device as the node knows it.
struct WhoAmI: Decodable, Sendable, Equatable {
    let device: String
    let kind: String
    let scopes: [String]
    let node: String
    let nodeName: String
    let fleet: String?
    let fleetName: String?
    /// What the primary is called, where the node names it (absent: unnamed, "Invincible"; Primary.name).
    var primaryName: String? = nil
}

/// `GET /api/team`: the team's agents, their conversations and their work, in one snapshot.
struct TeamSnapshot: Decodable, Sendable {
    var agents: [Agent]
    var rooms: [TeamRoom]
    var tasks: [TeamTask]
    var deliveries: [TeamDelivery]
    var removed: [Removed]?
    /// The primary's own computer, once it has one: its VM, made and watched as an agent's is (under its handle).
    var computer: Agent.Workspace? = nil
    /// When you last looked, on any device, at each agent's page (`agent:<id>`) and each room (`room:<id>`): what ended
    /// there after it is new to you (absent from an older node, which keeps no such thing).
    var seen: [String: Double]? = nil

    struct Removed: Decodable, Sendable { let id: String; let name: String }
}

struct Agent: Decodable, Sendable, Identifiable {
    let id: String
    let name: String
    let instructions: String
    let role: String
    /// Its own models, in place of its role's, in order (absent: its role's).
    var models: [String]? = nil
    /// Sensitive mode: every call of its work on its own models alone, never a fallback (core's heldModels).
    var sensitive: Bool? = nil
    let harness: String
    /// The command that starts its ACP agent in its VM (harness `acp`).
    var acp: String? = nil
    /// Keys of yours it may use but never see (PLAN #17): the gateway puts each in at its own address alone.
    var keys: [KeyGrant]? = nil

    /// A key it was given: which secret, the header it goes in, and whether calls that change something may go too.
    struct KeyGrant: Codable, Sendable, Equatable, Hashable { let secret: String; var header: String; var write: Bool }
    let enabled: Bool
    let dailyTurns: Int
    let turnsToday: Int
    let repository: String?
    /// Its saved avatar: the colour you chose for its orb (core's OrbProfile, read by AgentOrb.chosenColor), or a look
    /// from before the orbs, which colours nothing. Checked field by field before it colours anything.
    let avatar: JSONValue?
    /// Who made it: `owner` (also what its absence means), `primary`, or the agent that did.
    let createdBy: String?
    /// Whose words its job is: `owner`, `primary`, or the agent that made it (absent: yours).
    var instructionsBy: String? = nil
    /// Its VM, once it has one; `workspaceNode`, the host chosen for one being made.
    var workspace: Workspace? = nil
    var workspaceNode: String? = nil
    /// Its own working notes.
    var memory: String? = nil

    struct Workspace: Decodable, Sendable, Equatable { let node: String; let id: String }
}

/// Whose VM a screen or a terminal is: an agent's, or the primary's own computer, under its reserved handle.
struct VMSeat: Sendable {
    let id: String
    let name: String
    /// Its sandbox, once it has one.
    let sandbox: String?

    init(_ agent: Agent) {
        id = agent.id
        name = agent.name
        sandbox = agent.workspace?.id
    }

    /// The primary's own computer.
    init(computer: Agent.Workspace) {
        id = "primary"
        name = Primary.name
        sandbox = computer.id
    }
}

struct TeamRoom: Decodable, Sendable {
    let id: String
    let name: String
    let members: [String]
    let direct: Bool
    /// Replies its agents may give to one thing you say, handoffs between them included.
    var turnBudget: Int? = nil
    let paused: Bool
    let updatedAt: Double
}

struct TeamTask: Decodable, Sendable {
    /// What it changed in its repository, kept on the node: the artifact, how many files, and the commit it began from.
    struct Changes: Decodable, Sendable { let files: Int; let artifact: String?; var base: String? = nil }
    /// What its run came to, as the runner counted it (never the agent's own account): when the agent began and ended,
    /// how its run ended (done · unverified · gave-up · stopped), and its model calls by role and model (core's
    /// TeamTaskRecord). Absent until it has ended in the agent's hands.
    struct Record: Decodable, Sendable {
        let startedAt: Double
        let endedAt: Double
        let ended: String
        var commands: Int? = nil
        var revisions: Int? = nil
        let spent: [UsageLine]
        /// What proves it, as the runner saw it (core's TeamTaskProof; absent from a record made before it was kept).
        var proof: Proof? = nil

        struct Proof: Decodable, Equatable, Sendable {
            /// Each gate's exit before any work, and in the last round.
            let before: [Int]
            let after: [Int]
            /// The reviewer's last verdict (pass · revise), and whether it was by the model that did the work.
            let review: String?
            let sameModel: Bool
        }
    }
    let id: String
    let room: String
    let assignee: String
    let title: String
    let goal: String
    let dependsOn: [String]
    /// The commands that prove it done.
    var gates: [String]? = nil
    /// Its budget in US dollars at your prices (nil: none).
    var budgetUsd: Double? = nil
    /// What its run came to (nil: not run yet, or from before records were kept).
    var record: Record? = nil
    /// queued · running · done · failed · stopped · interrupted
    let status: String
    let verified: Bool
    let progress: String
    /// What the agent said of it when it ended, then the review's lines.
    var output: String? = nil
    let error: String?
    var createdAt: Double? = nil
    let updatedAt: Double
    let changes: Changes?
    /// Who gave it to the agents rather than to an agent by name (owner or primary).
    var givenBy: String? = nil
    /// The agent that proposed it in a conversation; while its status is `proposed` it waits for your approval.
    var proposedBy: String? = nil
    /// Each time you stepped in on it, by how (approval · message · takeover · stop · resume · again).
    var interventions: [String: Int]? = nil
    /// Sensitive mode for this task alone: the models every call of its work is held to (nil: its agent's).
    var models: [String]? = nil
    /// The pull request whose failing checks or review it fixes: its fix goes onto that branch, never a new pull request.
    struct Fix: Decodable, Sendable { let branch: String }
    var fix: Fix? = nil
    /// Its pull request, once you shipped its work from an app.
    struct Shipped: Decodable, Sendable { let url: String; let pr: Int? }
    var shipped: Shipped? = nil
    /// Your words to it while it ran, and your agent's, in order (core's TeamSteer): each with where its run took them, or
    /// none while they are on their way (and for good once it ended first).
    struct Steer: Decodable, Equatable, Sendable {
        struct Taken: Decodable, Equatable, Sendable { let at: Double; let step: Int }
        /// owner · primary
        let by: String
        let text: String
        let at: Double
        var taken: Taken? = nil
    }
    var steers: [Steer]? = nil
}

/// An agent's reply on its way (or how it went).
struct TeamDelivery: Decodable, Sendable {
    let id: String
    let room: String
    let agent: String
    let status: String
    let error: String?
    let updatedAt: Double
}

/// `POST /api/away` (PLAN #37): what happened since this device last showed you, a line each in its state's colour.
struct AwayView: Decodable, Sendable, Equatable {
    struct Line: Decodable, Sendable, Hashable {
        let text: String
        /// ok · warn · danger · neutral
        let tone: String
    }
    let since: Double
    let lines: [Line]
}

/// `GET /api/actions`: what its policy made it ask about. Only a waiting one is yours to answer.
struct ActionView: Decodable, Sendable, Identifiable, Equatable {
    let id: String
    let connector: String
    let tool: String
    let args: [String: JSONValue]
    /// read · create · modify · outward · delete
    let kind: String
    let target: String
    /// Who asked: `arm:…`, `loop:…`, `node:…`, `you`.
    let by: String
    let why: String?
    let node: String
    /// An HLC.
    let requestedAt: String
    /// Unanswered by then, and it's no.
    let expires: Double
    let state: String

    enum CodingKeys: String, CodingKey {
        case id, connector, tool, args, kind = "class", target, by, why, node, requestedAt, expires, state
    }

    func waiting(at now: Date = .now) -> Bool { state == "waiting" && expires > now.timeIntervalSince1970 * 1000 }
}

/// `GET /api/secret-requests`: a key the primary asked for. It learns that it exists, never what it is.
struct SecretRequestView: Decodable, Sendable, Identifiable, Equatable {
    let name: String
    let provider: String?
    let purpose: String
    /// An HLC.
    let requestedAt: String
    let requestedBy: String
    var id: String { name }
}

/// `GET /api/notices`: something the node noticed for you (a heartbeat's finding, a rule of yours that told you), kept
/// until you dismiss it. Its title and body are the node's own words.
struct NoticeView: Decodable, Sendable, Identifiable, Equatable {
    let key: String
    /// alert · warn · info
    let severity: String
    let title: String
    let body: String
    /// What raised it: `heartbeat`, `loop:<name>`, `rule:<name>`, `ci`, `compute`.
    let source: String
    /// The node it is about, when it is about one.
    let node: String?
    /// When, in milliseconds.
    let at: Double
    let dismissed: Bool
    var id: String { key }
}

/// `GET /api/screen/sessions`: the primary's ask to use a Mac itself, or its session there (core's screen.ts): its only
/// once you allow it, for its minutes from your answer, until you or it ends it.
struct ScreenSessionView: Decodable, Sendable, Identifiable, Equatable {
    let id: String
    let node: String
    let nodeName: String
    /// What it wants it for: its words.
    let why: String
    let minutes: Int
    /// Milliseconds.
    let askedAt: Double
    /// waiting · lapsed · denied · allowed · over · ended
    let state: String
    let answerBy: Double
    let until: Double?
}

/// `GET /api/questions`: an MCP server's question to you, asked in the middle of a call (core's questions.ts). Its call
/// waits for your answer, your no, or its time running out; nothing answers it but you.
struct QuestionView: Decodable, Sendable, Identifiable, Equatable {
    let id: String
    let connector: String
    /// The connector's name, as you installed it.
    let label: String
    /// What it asks: the server's words, one line.
    let message: String
    let fields: [QuestionField]
    /// Milliseconds.
    let askedAt: Double
    let expires: Double
}

/// One thing a server's question asks for: a text, a number, a yes or no, or one or several of a list.
struct QuestionField: Decodable, Sendable, Equatable {
    struct Option: Decodable, Sendable, Equatable { let value: String; let title: String }
    let name: String
    /// text · number · yes-no · one · many
    let kind: String
    let title: String
    let description: String?
    let required: Bool
    /// A text's kind: email, uri, date or date-time.
    let format: String?
    let integer: Bool?
    let options: [Option]?
    let `default`: JSONValue?
}

/// What you fill in for one field of a server's question, as the node takes it.
enum QuestionAnswer: Encodable, Equatable {
    case text(String), number(Double), yes(Bool), several([String])

    func encode(to encoder: any Encoder) throws {
        var value = encoder.singleValueContainer()
        switch self {
        case .text(let text): try value.encode(text)
        case .number(let number): try value.encode(number)
        case .yes(let yes): try value.encode(yes)
        case .several(let values): try value.encode(values)
        }
    }
}

/// `GET /api/pairings`: a device asking to join, with the code it shows.
/// `GET /api/about-you`: a fact about you, as a memory of the mind. Yours (`owner`) goes with every answer it gives; its
/// (an agent's) is only proposed, and waits for you to keep it.
struct Fact: Decodable, Sendable, Identifiable, Equatable {
    let id: String
    let text: String
    let trust: String
}

/// What it knows of you: what you kept, and what it proposed.
struct AboutYou: Decodable, Sendable {
    let kept: [Fact]
    let proposed: [Fact]
}

struct PairingView: Decodable, Sendable, Identifiable, Equatable {
    let invite: String
    let device: String
    let name: String
    let kind: String
    let sas: String
    let requestedAt: Double
    let conflict: Bool
    var id: String { "\(invite):\(device)" }
}

/// `GET /api/turns`: what the node is answering now.
struct TurnView: Decodable, Sendable, Equatable {
    let id: String
    let conversation: String?
    let title: String?
    let step: String?
    /// Whether this device may watch it (false: it read the bank, and this device may not). Absent from an older node.
    let watchable: Bool?
}

/// `GET /api/runs`: a run in hand.
struct RunView: Decodable, Sendable, Equatable {
    let goal: String
}

/// The millisecond time an HLC (`<15-digit ms>.<6-digit counter>`) was taken at, or nil.
func hlcDate(_ hlc: String) -> Date? {
    guard let ms = Double(hlc.split(separator: ".").first ?? ""), ms > 0 else { return nil }
    return Date(timeIntervalSince1970: ms / 1000)
}

/// A folder of an agent's workspace (`POST /api/team/files`): folders first.
struct TeamFilesView: Decodable, Sendable {
    struct Entry: Decodable, Sendable, Hashable {
        let name: String
        /// dir · file · link · other
        let kind: String
        let size: Int
        let modified: Double
    }
    let id: String
    let path: String
    let entries: [Entry]
    /// There were more than its first two thousand entries.
    let more: Bool
}

/// One file of an agent's workspace (`POST /api/team/file`): text (anything like a key redacted), a picture, or what it is.
struct TeamFileView: Decodable, Sendable {
    let path: String
    let size: Int
    /// text · image · binary · large
    let kind: String
    var text: String? = nil
    /// A picture's bytes, base64.
    var data: String? = nil
    var type: String? = nil
    var redacted: Bool? = nil
    /// Only its beginning is here.
    var cut: Bool? = nil
}

/// What an agent's task changed in its repository (`POST /api/team/changes`).
struct TeamChangesView: Decodable, Sendable {
    struct File: Decodable, Sendable, Hashable {
        let path: String
        /// git's letter: A, M, D, T
        let status: String
        let added: Int?
        let removed: Int?
    }
    let task: String?
    let path: String?
    let base: String?
    let head: String?
    let files: [File]
    let untracked: [String]
    let diff: String
    let cut: Bool
    var redacted: Bool? = nil
}

/// A project (core's ProjectView): its name, the primary's instructions for it, its repository, and its checkout on its computer.
struct ProjectView: Decodable, Sendable, Identifiable, Equatable, Hashable {
    let id: String
    let name: String
    let instructions: String
    let repo: String?
    /// Where its work is kept on its computer (nil from a node from before the Build view).
    var checkout: String? = nil
    let updatedAt: Double
}

/// A project's checkout as git has it (`POST /api/projects/git`).
struct ProjectGitView: Decodable, Sendable, Equatable {
    struct Commit: Decodable, Sendable, Equatable, Hashable {
        let sha: String
        let subject: String
        let at: Double
    }
    let checkout: String
    /// ready · missing (not cloned yet) · not-a-repository
    let state: String
    let branch: String?
    let head: String?
    let branches: [String]
    /// Files changed or new, not yet committed.
    let changed: Int
    let upstream: String?
    let ahead: Int?
    let behind: Int?
    let remote: String?
    let log: [Commit]
}

/// This period's model calls on the node at your prices, against your budget (`GET /api/usage/meter`).
struct UsageMeter: Decodable, Sendable, Equatable {
    struct Top: Decodable, Sendable, Equatable, Hashable {
        let model: String
        let usd: Double?
        let tokens: Int
    }
    /// day · month
    let per: String
    let since: String
    let budgetUsd: Double?
    let spentUsd: Double
    /// Every call was counted and priced: `spentUsd` is the whole of it, not a lower bound.
    let complete: Bool
    let unpriced: [String]
    let tokens: Int
    let calls: Int
    let leftUsd: Double?
    let top: [Top]
    /// Coding plans whose allowance is spent now, as their providers said and until when: their models are passed over
    /// until then (absent when there are none, and from an older node).
    var windows: [SpentWindow]? = nil

    struct SpentWindow: Decodable, Sendable, Equatable, Hashable {
        let provider: String
        /// When it resets (ms since 1970).
        let until: Double
        /// What the provider said (cut short).
        let said: String
    }
}
