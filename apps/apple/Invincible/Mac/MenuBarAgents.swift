#if os(macOS)
import AppKit
import SwiftUI

/// The team's mark in the menu bar, drawn as the bar draws its own (a template, in the bar's ink), with how many
/// things need you beside it when any do.
struct MenuBarMark: View {
    let mac: MacApp
    @Environment(\.openWindow) private var openWindow

    var body: some View {
        let count = mac.session?.needsYou ?? 0
        HStack(spacing: Space.line) {
            Image(nsImage: Self.mark)
            if count > 0 { Text("\(count)").monospacedDigit() }
        }
        .accessibilityLabel(count > 0 ? "\(Primary.name): \(PrimaryNow.needsYou(count))" : Primary.name)
        // There while the app runs, windows or not: the Dock's badge is what needs you, and a notification tapped opens
        // the main window, which goes where it asked (MacPlaces).
        .onChange(of: count, initial: true) { NSApplication.shared.dockTile.badgeLabel = count > 0 ? "\(count)" : nil }
        .onChange(of: MacNotices.shared.opened) { _, asked in
            guard asked != nil else { return }
            openWindow(id: MacApp.main)
            NSApplication.shared.activate()
        }
    }

    /// The mark at the menu bar's size, as a template.
    private static let mark: NSImage = {
        let image = (NSImage(named: "Agents")?.copy() as? NSImage) ?? NSImage()
        image.size = NSSize(width: 18, height: 18)
        image.isTemplate = true
        return image
    }()
}

/// The agents in the menu bar, its status at a glance (PLAN #24): the agents in your order, each face in the ring of
/// where it stands with what it is doing; what needs you, which opens the Inbox; the node in a line; and Invincible's window.
/// A seat opens its page there.
struct MenuBarAgents: View {
    let mac: MacApp
    @Environment(\.openWindow) private var openWindow
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        VStack(alignment: .leading, spacing: Space.s1) {
            HStack(spacing: Space.s2) {
                AgentsMark(size: 20)
                Text("Agents").font(.headline)
            }
            .padding(.horizontal, Space.s2)
            .padding(.vertical, Space.s1)
            if let session = mac.session {
                paired(session)
            } else {
                Text(mac.app.phase.isLoading ? "Reading this Mac's key…" : "This Mac isn't in a fleet yet: join it in Invincible's window.")
                    .font(.callout)
                    .foregroundStyle(.secondary)
                    .padding(.horizontal, Space.s2)
                    .padding(.bottom, Space.s1)
                Divider().padding(.vertical, Space.s1)
            }
            MenuRow(action: { show(nil) }) {
                Text("Open Invincible")
            }
        }
        .padding(Space.s2)
        .frame(width: 340)
        .tint(.ink)
    }

    @ViewBuilder private func paired(_ session: Session) -> some View {
        let rows = Dictionary(session.rows.map { ($0.id, $0) }) { first, _ in first }
        Divider().padding(.vertical, Space.s1)
        ScrollView {
            VStack(alignment: .leading, spacing: 0) {
                ForEach(session.seats, id: \.self) { id in
                    if id == "primary" {
                        MenuRow(action: { show(.primary) }) {
                            SidebarSeat(id: id, name: Primary.name, line: session.primary.line, needs: session.primary.tone == .warn, standing: session.primaryStanding)
                        }
                    } else if let row = rows[id] {
                        MenuRow(action: { show(.agent(id)) }) {
                            SidebarSeat(id: id, profile: session.agent(id)?.avatar, name: row.name, line: row.line, needs: row.needs, standing: row.standing)
                        }
                    }
                }
            }
        }
        // Up to about eight seats before it scrolls; fewer take only their own height.
        .frame(maxHeight: 8 * (Metrics.sidebarSeat + Space.s3))
        .fixedSize(horizontal: false, vertical: true)
        Divider().padding(.vertical, Space.s1)
        let count = session.needsYou
        MenuRow(action: { show(.inbox) }) {
            HStack(spacing: Space.s2) {
                if count > 0 {
                    NeedsMark()
                    Text(PrimaryNow.needsYou(count)).foregroundStyle(Color.danger)
                } else {
                    Image(systemName: "checkmark.circle").foregroundStyle(.secondary)
                    Text(session.inboxLoaded ? "Nothing needs you" : "Looking at what needs you…").foregroundStyle(.secondary)
                }
                Spacer(minLength: Space.s2)
                Text("Needs you").foregroundStyle(.secondary)
                Image(systemName: "chevron.right").font(.caption.weight(.semibold)).foregroundStyle(.tertiary)
            }
        }
        NodeLine(session: session).padding(.horizontal, Space.s2).padding(.vertical, Space.s1)
        Divider().padding(.vertical, Space.s1)
    }

    /// Invincible's window in front, at `place` when one is given.
    private func show(_ place: Place?) {
        if let place { mac.place = place }
        openWindow(id: MacApp.main)
        NSApplication.shared.activate()
        dismiss()
    }
}

/// The node this Mac is paired with, in a line: its name and its fleet's, and whether it answers (a dot in green when it
/// does; grey when it can't be reached, which isn't an error; the primary's red when it won't take this Mac's requests).
struct NodeLine: View {
    let session: Session

    var body: some View {
        let name = session.whoami?.nodeName ?? session.node.nodeName ?? "Your node"
        let fleet = session.whoami?.fleetName ?? session.node.fleetName
        let (state, color): (String, Color) = if let trouble = session.trouble {
            trouble.notYourNode != nil ? ("Isn't the node this Mac paired with", .danger) : trouble.unreachable ? ("Can't be reached", .secondary) : ("Doesn't accept this Mac", .danger)
        } else if session.whoami != nil {
            ("Connected", .green)
        } else {
            ("Connecting…", .secondary)
        }
        HStack(spacing: Space.s2) {
            Circle().fill(color).frame(width: 8, height: 8)
            Text([name, fleet.map { "fleet \($0)" }, state].compactMap { $0 }.joined(separator: " · "))
                .font(.callout)
                .foregroundStyle(.secondary)
                .lineLimit(1)
        }
        .help(session.node.origin.absoluteString)
        .accessibilityElement(children: .combine)
    }
}

/// A row of a menu bar panel: the whole row a button, lit under the pointer as a menu's items are.
private struct MenuRow<Label: View>: View {
    let action: () -> Void
    @ViewBuilder let label: Label
    @State private var hovering = false

    var body: some View {
        Button(action: action) {
            label
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.horizontal, Space.s2)
                .padding(.vertical, Space.line)
                .frame(minHeight: 24)
                .background(hovering ? AnyShapeStyle(.fill.secondary) : AnyShapeStyle(.clear), in: .rect(cornerRadius: Space.s2, style: .continuous))
                .contentShape(.rect)
        }
        .buttonStyle(.plain)
        .onHover { hovering = $0 }
    }
}

extension AppModel.Phase {
    var isLoading: Bool { if case .loading = self { true } else { false } }
}
#endif
