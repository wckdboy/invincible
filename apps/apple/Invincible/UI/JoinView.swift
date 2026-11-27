import SwiftUI

/// Joining the fleet: paste the invite link, name this device, ask; then compare the code with the node's and wait for
/// your approval there. It is the PWA's pairing page, in the system's own form.
struct JoinView: View {
    let app: AppModel
    /// An invite this device was handed (on a Mac, by an `invincible:` link): put in the link's field, as a paste is.
    var handed: String? = nil
    @State private var model = PairingModel()
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        NavigationStack {
            GroupedList {
                Section {
                    VStack(spacing: Space.s3) {
                        AppMark(size: 88)
                        Text("Join your fleet").font(.largeTitle.bold()).multilineTextAlignment(.center)
                        Text("This \(ThisDevice.kind) gets its own key. It can sign, but it can never be read out, not even by this app.")
                            .font(.subheadline)
                            .foregroundStyle(.secondary)
                            .multilineTextAlignment(.center)
                    }
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, Space.s2)
                }
                .listRowBackground(Color.clear)
                .listRowSeparator(.hidden)

                switch model.stage {
                case .entering, .asking: asking
                case .waiting(let code, let note): waiting(code: code, note: note)
                case .approved: approved
                case .stopped(let why): stopped(why)
                case .refusedKey: refusedKey
                }
            }
            .hairlinePage()
            .screen("join.screen")
            // Asking turning into waiting for your approval is shown moving, unless the device asks for less motion.
            .animation(reduceMotion ? nil : .default, value: model.stage)
        }
        .onChange(of: handed, initial: true) { _, link in
            if let link, model.stage == .entering { model.link = link }
        }
    }

    @ViewBuilder private var asking: some View {
        Section {
            FormField("Paste the invite link", text: $model.link, axis: .vertical)
                .lineLimit(2...5)
                .font(.footnote.monospaced())
                .capitals(.never)
                .autocorrectionDisabled()
                .keyboard(.url)
                .accessibilityIdentifier("invite-link")
            PasteButton(payloadType: String.self) { strings in
                model.link = strings.first ?? ""
            }
        } header: {
            SectionHead("Invite link")
        } footer: {
            PageNote("From `invincible invite --client` on your node, or from Invite a device in Invincible on another of your devices.")
        }
        Section {
            FormField("Name", text: $model.name)
                .capitals(.words)
                .autocorrectionDisabled()
                .accessibilityIdentifier("device-name")
        } header: {
            SectionHead("Name this device")
        } footer: {
            PageNote("How it appears in your fleet's device list.")
        }
        if let problem = model.problem {
            Section {
                Label(problem, systemImage: "exclamationmark.triangle.fill").foregroundStyle(Color.danger)
            }
        }
        Section {
            Button {
                model.ask(app: app)
            } label: {
                HStack(spacing: Space.s2) {
                    if model.stage == .asking { ProgressView().tint(Color.onAccent) }
                    Text("Ask to join").fontWeight(.semibold)
                }
                .foregroundStyle(Prominent.label(dimmed: !(model.canAsk || model.stage == .asking)))
                .frame(maxWidth: .infinity, minHeight: 34)
            }
            .buttonStyle(.glassProminent)
            .disabled(!model.canAsk)
            .listRowBackground(Color.clear)
            .listRowSeparator(.hidden)
            .listRowInsets(EdgeInsets(top: Space.s4, leading: Metrics.margin, bottom: Space.s4, trailing: Metrics.margin))
            .accessibilityIdentifier("ask-to-join")
        }
    }

    private func waiting(code: String, note: String) -> some View {
        Group {
            Section {
                VStack(spacing: Space.s3) {
                    Text("Your code").font(.subheadline).foregroundStyle(.secondary)
                    Text(code)
                        .font(.system(size: 46, weight: .semibold, design: .monospaced))
                        .accessibilityLabel(code.map(String.init).joined(separator: " "))
                        .accessibilityIdentifier("pairing-code")
                    Text("On your node, approve \(Text(model.name).bold()) only if it shows this exact code: in Needs you on another device, or in the terminal running `invincible invite`.")
                        .font(.footnote)
                        .multilineTextAlignment(.center)
                    HStack(spacing: Space.s2) {
                        ProgressView()
                        Text(note)
                    }
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                }
                .frame(maxWidth: .infinity)
                .padding(.vertical, Space.s2)
            }
            Section {
                Button("Cancel", role: .cancel) { model.cancel() }
            }
        }
    }

    private var approved: some View {
        Section {
            Label("Approved and verified. Welcome to the fleet.", systemImage: "checkmark.shield.fill")
                .font(.headline)
        }
    }

    private func stopped(_ why: String) -> some View {
        Group {
            Section {
                Label("Pairing stopped", systemImage: "xmark.octagon.fill").font(.headline).foregroundStyle(Color.danger)
                Text(why)
            } footer: {
                Text("Ask for a fresh invite with `invincible invite --client`.")
            }
            Section {
                Button("Start again") { model.restart() }
            }
        }
    }

    private var refusedKey: some View {
        Group {
            Section {
                Label("This device's key isn't accepted", systemImage: "key.slash").font(.headline).foregroundStyle(Color.danger)
                Text("The fleet knows this device's key, but the node won't accept it. If it was revoked, forget the key and use a fresh invite.")
            }
            Section {
                Button("Forget this device's key", role: .destructive) { model.forgetKey(app: app) }
            }
        }
    }
}
