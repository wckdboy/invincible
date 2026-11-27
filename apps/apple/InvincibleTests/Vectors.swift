import Foundation
@testable import Invincible

/// The test vectors `packages/core` makes (`scripts/vectors.ts`): what a node itself computes and verifies. Every key in
/// them is a fake made for these tests.
struct Vectors: Decodable {
    struct Auth: Decodable {
        let domain: String
        let headers: [String: String]
        let maxSkewMs: Int
    }

    struct Base64URLCases: Decodable {
        struct Encoded: Decodable { let hex: String; let b64u: String }
        struct Decoded: Decodable { let text: String; let hex: String? }
        let encode: [Encoded]
        let decode: [Decoded]
    }

    struct Identity: Decodable {
        let scalarHex: String
        let publicKey: String
        let device: String
    }

    struct Request: Decodable {
        let method: String
        let path: String
        let ts: String
        let nonce: String
        let body: String
        let bodySha256: String
        let signingInput: String
        let signature: String
        let signatureHighS: String
        let signatureDer: String
        let headers: [String: String]
    }

    struct Canonical: Decodable {
        let value: [String: String]
        let canonical: String
    }

    struct Pairing: Decodable {
        struct Decode: Decodable { let text: String; let invite: Invite? }
        struct Proof: Decodable { let name: String; let canonical: String; let proof: String }
        struct Code: Decodable { let fleet: String; let device: String; let sas: String }
        let secretText: String
        let invite: Invite
        let token: String
        let url: String
        let decode: [Decode]
        let device: String
        let proofs: [Proof]
        let sas: String
        let codes: [Code]
        let statusProof: String
        let approvalProof: String
    }

    struct AgentsSection: Decodable {
        struct Row: Decodable { let id: String; let line: String; let needs: Bool; let expression: String?; let state: String }
        struct Beside: Decodable { let line: String; let state: String; let beside: String }
        struct Now: Decodable { let input: PrimaryWork; let text: String; let tone: String; let state: String; let needsFirst: String }
        struct Needs: Decodable { let inbox: Int; let agents: [String]; let needs: Int }
        let now: Double
        let snapshot: TeamSnapshot
        let asks: [Ask]
        let rows: [Row]
        let besides: [Beside]
        let primary: [Now]
        let needs: [Needs]
    }

    struct Rooms: Decodable {
        struct Row: Decodable { let id: String; let line: String; let needs: Bool }
        let snapshot: TeamSnapshot
        let rows: [Row]
    }

    /// What is new to you among the agents (a snapshot with `seen`): each row, agents then rooms, as the PWA has it.
    struct Unread: Decodable {
        struct Row: Decodable { let id: String; let kind: String; let line: String; let needs: Bool; let unread: Bool; let state: String? }
        let snapshot: TeamSnapshot
        let rows: [Row]
    }

    struct AgentForms: Decodable {
        struct Handle: Decodable { let name: String; let taken: [String]; let handle: String }
        struct Removal: Decodable {
            struct Plan: Decodable { let blocked: String?; let lines: [String]; let destroyWorkspace: Bool }
            let id: String
            let name: String
            let workspace: Bool
            let workspaceNode: Bool
            let maySandbox: Bool
            let plan: Plan
        }
        struct RoleCase: Decodable { let roster: [String: Agents.RoleInfo]; let current: String?; let roles: [String] }
        struct RoleLine: Decodable { let role: String; let spec: Agents.RoleInfo?; let line: String }
        struct Budget: Decodable { let text: String; let usd: Double?; let error: String? }
        struct ModelChoices: Decodable { let choices: [Agents.ModelChoice]; let own: [String]?; let offered: [Agents.ModelChoice] }
        struct ModelToggle: Decodable { let own: [String]; let ref: String; let on: Bool; let after: [String] }
        struct ModelLine: Decodable { let own: [String]; let role: String; let spec: Agents.RoleInfo?; let sensitive: Bool?; let line: String }
        struct WorksOn: Decodable { let role: String; let models: [String]?; let sensitive: Bool?; let words: String }
        let handles: [Handle]
        let removals: [Removal]
        let roles: [RoleCase]
        let roleLines: [RoleLine]
        let budgets: [Budget]
        let modelChoices: [ModelChoices]
        let modelToggles: [ModelToggle]
        let modelLines: [ModelLine]
        let worksOn: [WorksOn]
    }

    struct KeyCases: Decodable {
        struct Detected: Decodable { let key: String; let provider: String?; let signIn: ProvidersView.SignIn? }
        struct PlanLine: Decodable { let id: String; let line: String? }
        struct Request: Decodable, Equatable { let id: String; let kind: String?; let baseUrl: String?; let secret: String }
        struct Setup: Decodable { let provider: String; let secret: String; let may: Bool; let baseUrl: String?; let request: Request?; let say: String? }
        let presets: [ProvidersView.Preset]
        let signIns: [ProvidersView.SignInForm]
        let providers: [ProvidersView.Provider]
        let detected: [Detected]
        let plans: [PlanLine]
        let setups: [Setup]
    }

    struct DesktopCases: Decodable {
        struct XY: Decodable, Equatable { let x: Double; let y: Double }
        struct Box: Decodable { let left: Double; let top: Double; let width: Double; let height: Double }
        struct Size: Decodable { let width: Int; let height: Int }
        struct Point: Decodable { let tap: XY; let shown: Box; let screen: Size; let point: XY? }
        struct Address: Decodable { let text: String; let address: String? }
        struct Shot: Decodable { let view: DesktopShot; let shown: Bool }
        let points: [Point]
        let unshown: XY?
        let addresses: [Address]
        let shots: [Shot]
    }

    /// An agent's desktop live (core's desktop-frames.ts, the PWA's lib/desktop-stream.ts), and the glass page's recording
    /// the decoder is tested on (bench/desktop/glass-clock.ts).
    struct DesktopStreamCases: Decodable {
        struct Frame: Decodable { let kind: UInt8; let time: UInt64; let payload: String; let chunk: Chunk? }
        struct Chunk: Decodable { let type: String; let timestamp: Double }
        struct Codec: Decodable { let payload: String; let codec: String? }
        struct Hold: Decodable { let held: DesktopHold; let at: Double; let ends: Double }
        struct Again: Decodable { let n: Int; let ms: Int }
        struct BehindRow: Decodable { let row: DesktopStream.Behinds?; let at: Double; let next: DesktopStream.Behinds; let tooOften: Bool }
        struct Glass: Decodable {
            struct Strip: Decodable { let x: Int; let y: Int; let block: Int; let bits: Int }
            struct Shown: Decodable { let kind: UInt8; let time: UInt64; let clicks: Int }
            struct Bits: Decodable { let time: UInt64; let clicks: Int; let bits: [Int] }
            let fixture: String
            let strip: Strip
            let frames: [Shown]
            let bits: Bits
        }
        let header: Int
        let most: Int
        let type: String
        let bytes: String
        let cuts: [[Int]]
        let frames: [Frame]
        let refused: [String]
        let codecs: [Codec]
        let holds: [Hold]
        let again: [Again]
        let liveTries: Int
        let behind: Int
        let behindTimes: Int
        let behindWithinMs: Double
        let behinds: [BehindRow]
        let glass: Glass
    }

    /// An agent's face (core's taskStep, and the mood it takes from what it is doing: lib/orb-motion.ts').
    struct Faces: Decodable {
        struct Step: Decodable { let line: String; let step: String }
        struct Mood: Decodable { let expression: String; let mood: String }
        let steps: [Step]
        let moods: [Mood]
    }

    /// How a face stands (the PWA's lib/orb.ts and lib/orb-motion.ts, whose orbs went with O2): the tone and the mood of
    /// each state the node names.
    struct OrbCases: Decodable {
        struct State: Decodable { let state: String; let tone: String }
        struct Motion: Decodable {
            struct State: Decodable { let state: String; let mood: String }
            let states: [State]
        }
        let states: [State]
        let motion: Motion
    }

    /// An agent's mark, the Grille (core's agent-mark.ts): its palette, its pale and grey forms, its forms and times, each
    /// expression's state, the marks a node gives, the snap of a colour you pick, saved marks read, and its slats at given
    /// moments with their colours.
    struct Marks: Decodable {
        struct Hue: Decodable { let name: String; let light: String; let dark: String }
        struct Forms: Decodable { let light: String; let dark: String }
        struct Form: Decodable { let slots: Int; let angle: Double }
        struct Timing: Decodable { let workCycle: Double; let needsBeat: Double; let doneSettle: Double; let failDrop: Double }
        struct StateOf: Decodable { let expression: String; let state: String }
        struct Mark: Decodable { let color: Int; let form: Int }
        struct Given: Decodable { let id: String; let seed: UInt32; let color: Int; let form: Int }
        struct Chosen: Decodable { let id: String; let others: [Mark]; let chosen: String; let mark: Mark }
        struct Snap: Decodable { let hex: String; let color: Int }
        struct SnapAll: Decodable { let digest: String; let counts: [Int] }
        struct Profile: Decodable { let id: String; let profile: JSONValue?; let saved: Bool; let mark: Mark }
        struct Slat: Decodable { let from: Double; let to: Double; let slide: Double; let fill: String; let drop: Double; let turn: Double; let pivot: [Double] }
        struct Geometry: Decodable { let angle: Double; let radius: Double; let slats: [Slat] }
        struct Colors: Decodable { let body: String; let key: String }
        struct Trig: Decodable { let x: Double; let sin: Double; let cos: Double }
        struct Case: Decodable {
            let id: String
            let mark: Mark
            let seed: UInt32
            let state: String
            let size: Double
            let theme: String
            let t: Double?
            let since: Double?
            let geometry: Geometry
            let colors: Colors
        }
        let palette: [Hue]
        let queued: [Forms]
        let paused: Forms
        let page: Forms
        let ink: Forms
        let red: Forms
        let forms: [Form]
        let timing: Timing
        let states: [String]
        let stateOf: [StateOf]
        let given: [Given]
        let chosen: [Chosen]
        let linear: [Double]
        let grey: Double
        let snaps: [Snap]
        let snapGrid: String
        let snapAll: SnapAll
        let profiles: [Profile]
        let geometry: [Case]
        /// Its sines and cosines (core's markSin and markCos, from + − × ÷ and floor alone), to the last bit.
        let trig: [Trig]
    }

    struct NoticeFrom: Decodable {
        let source: String
        let from: String
    }

    struct HighlightCase: Decodable {
        struct Piece: Decodable { let text: String; let tone: String? }
        let lang: String
        let code: String
        let pieces: [Piece]
    }

    struct ConnectorState: Decodable {
        struct State: Decodable { let label: String; let tone: String }
        let key: String
        /// Whose sign-in it uses (google · mcp), or nil for a key.
        let signIn: String?
        let state: State?
    }

    struct Thread: Decodable {
        struct Turn: Decodable, Equatable {
            let role: String
            let content: String
            let status: String
            let error: String?
            let sid: Int?
            let steps: [Step]
            /// A look of its come back (nil: a message of yours, or its answer).
            let look: StoredMessage.Look?
        }

        struct Step: Decodable, Equatable {
            let text: String
            let detail: String?
            let state: String
            let tool: String?
        }

        let name: String
        let role: String
        let messages: [StoredMessage]
        let question: String?
        /// Each a stream event; null: the stream ends; a string: the watching was cut with it.
        let events: [JSONValue]
        let turns: [Turn]
    }

    struct ChatList: Decodable {
        struct Group: Decodable { let label: String; let ids: [String] }
        struct State: Decodable {
            let state: String
            let queued: Int
            let held: String?
            let needs: ConversationSummary.Needs?
            let words: String
        }

        /// A kept chat that changed on another device: what was on screen, and each change with whether it is shown again.
        struct Changes: Decodable {
            struct Case: Decodable { let name: String; let kept: [StoredMessage]; let differs: Bool }
            let shown: [StoredMessage]
            let cases: [Case]
            /// This device's own exchange, not yet told its kept ids.
            let own: [Case]
            struct Refused: Decodable { let question: String; let error: String }
            struct Shown: Decodable { let role: String; let content: String; let status: String; let error: String? }
            struct Again: Decodable { let name: String; let kept: [StoredMessage]; let shown: [Shown]? }
            /// A send the node never took, and what is shown when the chat is read again (the PWA's shownAgain).
            let refused: Refused
            let again: [Again]
        }

        let now: Double
        let list: [ConversationSummary]
        let groups: [Group]
        let states: [State]
        let changes: Changes
    }

    struct MarkdownCase: Decodable {
        let source: String
        /// The PWA's tree for it, as lib/markdown.ts writes it ({t: "p", c: […]}, …).
        let blocks: [JSONValue]
    }

    struct BlockCases: Decodable {
        /// Core's answer: { ok: true, value } or { ok: false, why }.
        enum Read<T: Decodable & Sendable>: Decodable, Sendable {
            case ok(T)
            case no(String)
            private enum Keys: String, CodingKey { case ok, value, why }
            init(from decoder: any Decoder) throws {
                let c = try decoder.container(keyedBy: Keys.self)
                self = try c.decode(Bool.self, forKey: .ok) ? .ok(try c.decode(T.self, forKey: .value)) : .no(try c.decode(String.self, forKey: .why))
            }
        }

        struct Chart: Decodable {
            struct Series: Decodable { let name: String; let values: [Double?] }
            let type: String
            let title: String?
            let unit: String?
            let labels: [String]
            let series: [Series]
        }

        struct Stat: Decodable {
            let label: String
            let value: JSONValue
            let unit: String?
            let delta: Double?
            let note: String?
            let good: String?
        }

        struct Step: Decodable { let text: String; let state: String }
        struct Case<T: Decodable & Sendable>: Decodable, Sendable { let text: String; let read: Read<T> }
        struct Page: Decodable {
            /// The page, or (past the size limit) how many x's its paragraph holds.
            let text: String?
            let xs: Int?
            let ok: Bool
            let why: String?
            let title: String?
            var page: String { text ?? "<p>\(String(repeating: "x", count: xs ?? 0))</p>" }
        }
        struct Number: Decodable { let n: Double; let text: String }

        let charts: [Case<Chart>]
        let stats: [Case<[Stat]>]
        let choices: [Case<[String]>]
        let steps: [Case<[Step]>]
        let artifacts: [Page]
        let numbers: [Number]
    }

    struct Timelines: Decodable {
        struct Card: Decodable {
            struct Badge: Decodable { let text: String; let tone: String }
            struct End: Decodable { let why: String?; let said: String? }
            let id: String
            let badge: Badge
            let end: End?
            let actions: [String]
            let given: String?
            let sensitive: String?
            let kept: String?
            let proposed: String?
            let stepped: String?
            let shipped: String?
            let again: String
        }

        let messages: [TeamMessage]
        let tasks: [TeamTask]
        /// The timeline's keys: an agent's own room, a shared one, and the words since a moment.
        let agent: [String]
        let room: [String]
        let sinceAt: Double
        let since: [String]
        let speakers: [String]
        let cards: [Card]
    }

    let auth: Auth
    let base64url: Base64URLCases
    let identity: Identity
    let requests: [Request]
    let canonical: [Canonical]
    let pairing: Pairing
    let agents: AgentsSection
    let unread: Unread
    let rooms: Rooms
    let agentForms: AgentForms
    let keys: KeyCases
    let desktop: DesktopCases
    let desktopStream: DesktopStreamCases
    let faces: Faces
    let orb: OrbCases
    /// An agent's mark, the Grille (core's agent-mark.ts): AgentMarkTests.swift.
    let marks: Marks
    /// The work by attention (the PWA's lib/work.ts): WorkTests.swift.
    let work: WorkCases
    /// A task's work folded, its gates, review, live line, proof and cost (the PWA's lib/steps.ts): StepsTests.swift.
    let steps: StepCases
    let connectorStates: [ConnectorState]
    let threads: [Thread]
    let chats: ChatList
    /// The message box while it works: steer or queue, a side question, what waits above it (lib/turns.ts): ComposerTests.
    let composer: ComposerCases
    let markdown: [MarkdownCase]
    let blocks: BlockCases
    let timelines: Timelines
    /// Where a notice came from, in words (the PWA's lib/notices.ts).
    let notices: [NoticeFrom]
    /// What a native app does about its notifications when it opens (core's notifyReach).
    let notifyReach: [ReachCase]

    struct ReachCase: Decodable {
        let permission: String
        let subscribed: Bool
        let lost: Bool
        let reachable: Int
        let localOn: Bool
        let step: String
    }
    /// A notification's payload read strictly (core's readNotifyPayload), with what the node sends the iPhone for each one
    /// read (apns-send.ts applePayload), and its text cleaned (notifyClean): NotifyPayloadTests.swift.
    let notifyPayload: NotifyPayloadCases

    struct NotifyPayloadCases: Decodable {
        struct ReadCase: Decodable { let raw: JSONValue?; let read: JSONValue?; let apple: JSONValue? }
        struct CleanCase: Decodable { let text: String; let max: Int; let clean: String }
        let titleMax: Int
        let bodyMax: Int
        let generic: JSONValue
        let read: [ReadCase]
        let clean: [CleanCase]
    }
    /// Code, coloured by what each part is (the PWA's lib/highlight.ts).
    let highlights: [HighlightCase]
    /// The mark, the I-beam (scripts/mark.ts): MarkTests.swift.
    let mark: Mark
    /// The live stream's timing (core's live.ts, the PWA's lib/live-link.ts): LiveLinkTests.swift.
    let live: Live
    /// The verdict in words that follow the proof (the PWA's lib/steps.ts verdictOf): StepsTests.swift.
    let verdicts: [VerdictCase]
    /// A task on its Live Activity: its state from the task and its trail, and its words (lib/live-activity.ts).
    let liveActivities: [LiveActivityCase]
    /// A loop's task, and what wakes it, in words (the PWA's lib/loops.ts and lib/wakes.ts): LoopsTests.swift.
    let loops: LoopCases
    /// An agent's own computer as the node makes it (core's computerSize): ComputerStartTests.swift.
    let computer: Computer
    /// How long the node lets a project's git run in the request that asked (packages/node's project-git.ts):
    /// NodeClientTests.swift.
    let projectGit: ProjectGit

    struct Computer: Decodable {
        struct Size: Decodable, Equatable { let cpus: Double; let memoryGb: Double; let diskGb: Double }
        struct Case: Decodable { let desktop: Bool; let size: Size }
        let sizes: [Case]
    }

    struct ProjectGit: Decodable {
        let cloneTimeoutS: Double
        let gitTimeoutS: Double
    }

    struct LoopCases: Decodable {
        struct TaskCase: Decodable { let task: JSONValue?; let words: String }
        struct WakesCase: Decodable { let wakes: [JSONValue]; let cooldownMs: Double?; let words: String }
        let tasks: [TaskCase]
        let wakes: [WakesCase]
    }

    struct LiveActivityCase: Decodable {
        struct Task: Decodable {
            let status: String
            let verified: Bool
            let error: String?
            let gates: [String]
            let record: TeamTask.Record?
        }
        let name: String
        let task: Task
        let entries: [TrailEntry]
        /// How many of the team's other tasks are at work besides it, and what its Lock Screen says of them.
        let others: Int
        let at: Double
        let state: TaskActivityState
        let line: String
        let short: String
        let othersLine: String
    }

    struct VerdictCase: Decodable {
        struct Task: Decodable {
            let status: String
            let verified: Bool
            let error: String?
            let record: TeamTask.Record?
        }
        struct Said: Decodable, Equatable {
            let word: String
            let verdict: String
        }
        let task: Task
        let verdict: Said?
    }

    struct ComposerCases: Decodable {
        struct Action: Decodable { let busy: Bool; let enter: String; let modifier: Bool; let canQueue: Bool; let action: String }
        struct Aside: Decodable { let text: String; let aside: String? }
        struct Steering: Decodable { let count: Int; let line: String }
        struct Head: Decodable { let queued: Int; let held: String?; let busy: Bool; let count: String; let rest: String }
        struct Undelivered: Decodable { let texts: Int; let queued: Bool; let title: String; let detail: String }
        struct Placeholder: Decodable { let canQueue: Bool; let words: String }
        struct AsideNote: Decodable { let working: Bool; let note: String }
        struct BroughtBack: Decodable { let how: String; let words: String }
        struct Said: Decodable { let title: String; let detail: String }
        let actions: [Action]
        let asides: [Aside]
        let steering: [Steering]
        let heads: [Head]
        let undelivered: [Undelivered]
        let placeholders: [Placeholder]
        let filesWait: String
        let justStarting: String
        let notKept: String
        let asideNotes: [AsideNote]
        let broughtBack: [BroughtBack]
        let nothingYet: Said
        struct AsidePlaceholder: Decodable { let working: Bool; let words: String }
        let asidePlaceholders: [AsidePlaceholder]
        let asideAnswering: String
        let asideFailed: String
        let bringBackFailed: String
    }

    struct Mark: Decodable {
        let rects: [[Double]]
        let polygon: String
        let box: Double
    }

    struct Live: Decodable {
        let beatMs: Double
        let silentMs: Double
        let helloWaitMs: Double
        let retryFirstMs: Double
        let retryMaxMs: Double
        let steadyMs: Double
        let gapMs: Double
        let topics: [String]
        /// Which a device keeps and opens the stream again from (core's LIVE_CURSOR), and the path it sends for each.
        let cursors: [Cursor]
        /// The web app's link played on a clock in hand: its steps, what it told and when, and when it opened each stream.
        let links: [Link]

        struct Cursor: Decodable {
            let cursor: String
            let kept: Bool
            let path: String
        }

        struct Link: Decodable {
            let name: String
            let steps: [Step]
            /// Each "<ms> up <topics>", "<ms> changed <topics>" or "<ms> down".
            let told: [String]
            let opened: [Double]
        }

        /// start, stop, hello (`topics`), end, offline, refusing, online, wait and steady (`ms`): apps/apple/scripts/vectors.ts.
        struct Step: Decodable {
            let act: String
            let topics: [String]?
            let ms: Double?
        }
    }

    static let shared: Vectors = {
        guard let url = Bundle(for: BundleToken.self).url(forResource: "core-vectors", withExtension: "json") else {
            fatalError("core-vectors.json isn't in the test bundle: run bun apps/apple/scripts/vectors.ts")
        }
        do {
            return try JSONDecoder().decode(Vectors.self, from: Data(contentsOf: url))
        } catch {
            fatalError("core-vectors.json doesn't decode: \(error)")
        }
    }()
}

private final class BundleToken {}

extension Data {
    /// Bytes from lowercase or uppercase hex; nil when it isn't hex.
    init?(hex: String) {
        guard hex.count.isMultiple(of: 2) else { return nil }
        var bytes = [UInt8]()
        var index = hex.startIndex
        while index < hex.endIndex {
            let next = hex.index(index, offsetBy: 2)
            guard let byte = UInt8(hex[index..<next], radix: 16) else { return nil }
            bytes.append(byte)
            index = next
        }
        self.init(bytes)
    }

    var hex: String { map { String(format: "%02x", $0) }.joined() }
}
