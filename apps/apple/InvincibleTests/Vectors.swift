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

    /// An agent's orb's colours (core's avatar.ts): the 24 tints and their names, agents' colours from their handles and
    /// saved avatars, handles' seeds, blends and the nearest tints.
    struct AgentOrbs: Decodable {
        struct Colors: Decodable { let tint: String; let light: String; let deep: String; let second: String; let chosen: Bool }
        struct Agent: Decodable { let id: String; let avatar: JSONValue?; let colors: Colors }
        struct Seed: Decodable { let id: String; let seed: UInt32 }
        struct Blend: Decodable { let from: String; let to: String; let t: Double; let blend: String }
        struct Nearest: Decodable { let color: String; let at: Int }
        let tints: [String]
        let names: [String]
        let agents: [Agent]
        let seeds: [Seed]
        let blends: [Blend]
        let nearest: [Nearest]
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

    /// An agent's face (core's taskStep, and the mood its orb takes from what it is doing: lib/orb-motion.ts').
    struct Faces: Decodable {
        struct Step: Decodable { let line: String; let step: String }
        struct Mood: Decodable { let expression: String; let mood: String }
        let steps: [Step]
        let moods: [Mood]
    }

    /// The primary's orb (the PWA's lib/orb.ts): each state's colours, the parts of each level, and the level of each size.
    struct OrbCases: Decodable {
        struct Palette: Decodable { let tint: String; let light: String; let deep: String }
        struct Stop: Decodable { let at: Double; let ink: String; let opacity: Double }
        /// A part as lib/orb.ts writes it: its kind, and that kind's fields.
        struct Part: Decodable {
            let name: String
            let kind: String
            let r: Double?
            let cx: Double?
            let cy: Double?
            let spread: Double?
            let stops: [Stop]?
            let width: Double?
            let ink: String?
            let opacity: Double?
            let arcs: [[Double]]?
            let count: Int?
            let offset: Double?
            let length: Double?
            let size: Double?
            let share: Double?
            let glyph: Double?
            let second: String?
        }
        struct Size: Decodable { let size: Double; let level: String }
        struct State: Decodable { let state: String; let tone: String }
        /// How it moves (the PWA's lib/orb-motion.ts): each mood's motion, each state's mood, its times, its stages, how
        /// a frame moves its parts, when it bursts, its seeds and random numbers, and its clock and frames at given moments.
        struct Motion: Decodable {
            struct Mood: Decodable {
                struct Turn: Decodable { let ring: Double; let ticks: Double; let segments: Double }
                struct Comet: Decodable { let speed: Double; let tail: Double }
                struct Motes: Decodable { let count: Int; let speed: Double; let sway: Double; let flow: String }
                let breath: Double
                let swell: Double
                let turn: Turn
                let comet: Comet?
                let ripple: Double?
                let motes: Motes
                let aura: Double
            }
            struct State: Decodable { let state: String; let mood: String }
            struct Stage: Decodable {
                struct Track: Decodable { let r: Double; let width: Double }
                let reach: Double
                let band: [Double]
                let mote: Double
                let share: Double
                let waves: [Double]
                let wave: Double
                let comet: Track?
            }
            struct Moves: Decodable { let ring: [String]; let ticks: [String]; let segments: [String]; let swell: [String]; let glow: [String]; let lightsBefore: String }
            struct Burst: Decodable { let from: String?; let to: String; let bursts: Bool }
            struct Seed: Decodable { let name: String; let seed: UInt32 }
            struct Rand: Decodable { let seed: UInt32; let i: Int; let k: Int; let value: Double }
            struct Clock: Decodable {
                let ring: Double
                let ticks: Double
                let segments: Double
                let head: Double
                let ringSpeed: Double
                let ticksSpeed: Double
                let segmentsSpeed: Double
                let headSpeed: Double
                let tail: Double
                let breath: Double
                let swell: Double
                let light: Double
                let aura: Double
            }
            struct ClockCase: Decodable { let mood: String; let seed: UInt32; let clock: Clock }
            struct Step: Decodable { let mood: String; let dt: Double; let clock: Clock }
            struct Mote: Decodable { let angle: Double; let u: Double; let size: Double; let alpha: Double }
            struct Light: Decodable { let head: Double; let tail: Double; let alpha: Double }
            struct Frame: Decodable {
                let scale: Double
                let glow: Double
                let aura: Double
                let ring: Double
                let ticks: Double
                let segments: Double
                let comet: Light?
                let ripples: [Double]
                let motes: [Mote]
                let leaving: [Mote]
                let sparks: [Mote]
            }
            struct FrameCase: Decodable { let mood: String; let seed: UInt32; let t: Double; let since: Double?; let from: String?; let burst: Bool; let clock: Clock; let frame: Frame }
            let moods: [String: Mood]
            let states: [State]
            let arrive: Double
            let burst: Double
            let burstMotes: Int
            let ease: Double
            let longestStep: Double
            let stages: [String: Stage]
            let moves: Moves
            let bursts: [Burst]
            let seeds: [Seed]
            let rands: [Rand]
            let clocks: [ClockCase]
            let start: Clock
            let steps: [Step]
            let frames: [FrameCase]
        }
        /// The spheres of glyphs (the PWA's lib/orb-sphere.ts): each handle's sphere, its points, its glyphs as they
        /// change, what is seen of them in given frames, the shades, an agent's arcs and the primary's data ring.
        struct Spheres: Decodable {
            struct Look: Decodable { let count: Int; let glyph: Double; let r: Double; let nucleus: Double }
            struct Sphere: Decodable { let seed: UInt32; let tilt: Double; let spin: Double; let phase: Double; let share: Double }
            struct Handle: Decodable { let handle: String; let sphere: Sphere }
            struct Point: Decodable { let x: Double; let y: Double; let z: Double; let second: Bool; let size: Double }
            struct Points: Decodable { let handle: String; let count: Int; let points: [Point] }
            struct Glyph: Decodable { let char: String; let data: Bool; let fade: Double }
            struct GlyphCase: Decodable { let seed: UInt32; let i: Int; let level: Int; let t: Double; let flash: Double; let glyph: Glyph }
            struct Shown: Decodable { let x: Double; let y: Double; let near: Double; let size: Double; let alpha: Double; let shade: Int; let second: Bool; let char: String; let data: Bool }
            struct Frame: Decodable {
                let handle: String
                let count: Int
                let angle: Double
                let scale: Double
                let radius: Double
                let glyph: Double
                let t: Double
                let mood: String
                let paper: Bool
                let shown: [Shown]
            }
            struct Shades: Decodable { let ink: String; let light: String; let deep: String; let shades: [String]; let paper: [String] }
            struct Arc: Decodable { let r: Double; let width: Double; let from: Double; let length: Double; let speed: Double }
            struct Arcs: Decodable { let handle: String; let level: String; let arcs: [Arc] }
            struct Place: Decodable { let char: String; let alpha: Double }
            struct Ring: Decodable { let seed: UInt32; let t: Double; let share: Double; let places: [Place?] }
            let agent: [String: Look]
            let turn: Double
            let ladder: [[String]]
            let data: String
            let flash: [String: Double]
            let spheres: [Handle]
            let points: [Points]
            let glyphs: [GlyphCase]
            let frames: [Frame]
            let shades: [Shades]
            let arcs: [Arcs]
            let ring: [Ring]
        }
        let palettes: [String: Palette]
        let levels: [String: [Part]]
        let sizes: [Size]
        let states: [State]
        let motion: Motion
        let sphere: Spheres
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
    let agentOrbs: AgentOrbs
    let agents: AgentsSection
    let unread: Unread
    let rooms: Rooms
    let agentForms: AgentForms
    let keys: KeyCases
    let desktop: DesktopCases
    let faces: Faces
    let orb: OrbCases
    /// The orbs as fields (the PWA's lib/field.ts and lib/field-orb.ts): FieldTests.swift.
    let field: FieldCases
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
        let at: Double
        let state: TaskActivityState
        let line: String
        let short: String
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

        struct Cursor: Decodable {
            let cursor: String
            let kept: Bool
            let path: String
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
