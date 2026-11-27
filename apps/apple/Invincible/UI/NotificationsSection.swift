import SwiftUI

/// Notifications on this iPhone, iPad or Mac: on and off, said plainly, and a test. What it tells you about and when it stays
/// quiet are the node's own settings, the same from every device (the web app's Settings, or `invincible notify`). An
/// iPhone's come through Apple's push service; a Mac collects its own from the node while the app runs (MacNotices).
struct NotificationsSection: View {
    let session: Session
    /// Whether the node notifies this device (nil: not read yet).
    @State private var on: Bool?
    @State private var busy = false
    @State private var said: String?
    @State private var problem: String?

    private struct Status: Decodable { let subscribed: Bool? }
    private struct Removed: Decodable { let removed: Bool }
    private struct Sent: Decodable { struct Line: Decodable { let ok: Bool; let error: String? }; let sent: [Line] }
    private struct Nothing: Encodable {}

    var body: some View {
        Section {
            Toggle(isOn: Binding(get: { on ?? false }, set: { want in Task { await turn(want) } })) {
                Label("Notifications on this \(ThisDevice.kind)", systemImage: "bell")
            }
            .disabled(on == nil || busy)
            if on == true {
                Button("Send a test") { Task { await test() } }
                    .disabled(busy)
            }
            if let said { Text(said).font(.footnote).foregroundStyle(.secondary) }
            if let problem {
                Label(problem, systemImage: "exclamationmark.triangle.fill").font(.footnote).foregroundStyle(Color.danger)
            }
        } header: {
            SectionHead("Notifications")
        } footer: {
            PageNote("\(Primary.name) comes to you here when something needs you: an approval, a key it asked for, a question, at once and with a sound; work that ended while you were away, quietly. A notification says fixed words only, never a key, your own words or a model's: the app shows those once you open it.")
        }
        .task { await load() }
    }

    private func load() async {
        do {
            on = try await session.client.get("/api/notify", as: Status.self).subscribed ?? false
        } catch {
            problem = error.localizedDescription
        }
    }

    private func turn(_ want: Bool) async {
        busy = true
        defer { busy = false }
        problem = nil
        said = nil
        do {
            if want {
                #if os(iOS)
                let service = try await PushCenter.shared.turnOn(session)
                said = "On, through \(service)'s push service."
                #else
                said = try await MacNotices.shared.turnOn(session)
                #endif
                on = true
            } else {
                _ = try await session.client.post("/api/notify/unsubscribe", Nothing(), as: Removed.self)
                on = false
                #if os(macOS)
                MacNotices.shared.turnedOff()
                #endif
            }
        } catch {
            problem = error.localizedDescription
        }
    }

    private func test() async {
        busy = true
        defer { busy = false }
        problem = nil
        do {
            let line = try await session.client.post("/api/notify/test", Nothing(), as: Sent.self).sent.first
            said = line?.ok == true ? "Sent: it arrives in a moment." : nil
            if line?.ok != true { problem = "It didn't go: \(line?.error ?? "no reason given")." }
        } catch {
            problem = error.localizedDescription
        }
    }
}

#if os(iOS)
/// The card at the top of the primary's home and the Inbox while it can't reach this device when Invincible is closed (the web
/// app's reachCard): its notifications were lost (Apple stopped taking its token), or no device of yours can be reached.
/// Turn on asks iOS from your tap (if it hasn't asked before); when iOS says no, Open Settings. Not now puts it away for a
/// week on this device. Each launch hands the token over again by itself while they're on (PushCenter.renew).
struct ReachCard: View {
    let session: Session
    @AppStorage("reach-put-away") private var putAway: Double = 0
    @State private var busy = false
    @State private var problem: String?
    @Environment(\.openURL) private var openURL

    private var center: PushCenter { .shared }
    private var away: Bool { Date.now.timeIntervalSince1970 - putAway < 7 * 24 * 3600 }

    var body: some View {
        if (center.reach == .turnOn || center.reach == .settings) && !away {
            VStack(alignment: .leading, spacing: Space.s2) {
                Label("\(Primary.name) can't reach this \(ThisDevice.kind) when the app is closed.", systemImage: "bell.slash").font(.headline)
                if let lost = center.lost { Text(Push.lostLine(at: lost.at, service: lost.service)).font(.callout).foregroundStyle(.secondary) }
                if center.reach == .settings {
                    Text("Notifications are off for Invincible in this \(ThisDevice.kind)'s Settings.").font(.callout).foregroundStyle(.secondary)
                }
                if let problem { Text(problem).font(.footnote).foregroundStyle(Color.danger) }
                HStack(spacing: Space.s3) {
                    if center.reach == .settings {
                        Button {
                            if let url = URL(string: UIApplication.openNotificationSettingsURLString) { openURL(url) }
                        } label: {
                            Text("Open Settings").foregroundStyle(Prominent.label())
                        }
                        .buttonStyle(.glassProminent)
                    } else {
                        // A prominent button's words are the ink's own colour, as every other one's: left to the
                        // style, they were cream on its cream ground in dark mode (26 November 2026).
                        Button { Task { await turnOn() } } label: {
                            Text("Turn on notifications").foregroundStyle(Prominent.label(dimmed: busy))
                        }
                        .buttonStyle(.glassProminent)
                        .disabled(busy)
                    }
                    Button("Not now") { putAway = Date.now.timeIntervalSince1970 }
                        .buttonStyle(.glass)
                }
            }
            .padding(Space.s3)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(.quaternary.opacity(0.5), in: .rect(cornerRadius: Metrics.cardRadius, style: .continuous))
        }
    }

    private func turnOn() async {
        busy = true
        defer { busy = false }
        problem = nil
        do {
            try await center.turnOn(session)
        } catch {
            problem = error.localizedDescription
        }
    }
}
#endif
