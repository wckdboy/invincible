import SwiftUI

/// Money and tokens as the node's own lines say them (core's spend.ts: `usdLabel`, `tokensLabel`).
enum Usage {
    static func usd(_ usd: Double) -> String {
        if usd == 0 { return "$0" }
        if usd < 0.01 { return String(format: "$%.4f", usd) }
        if usd < 10 { return String(format: "$%.2f", usd) }
        return usd < 100 ? String(format: "$%.1f", usd) : String(format: "$%.0f", usd)
    }

    static func tokens(_ n: Int) -> String {
        if n < 10_000 { return n.formatted(.number.locale(Locale(identifier: "en_US"))) }
        if n < 1_000_000 { return String(format: n < 100_000 ? "%.1fk" : "%.0fk", Double(n) / 1000) }
        return String(format: n < 10_000_000 ? "%.2fM" : "%.1fM", Double(n) / 1_000_000)
    }

    /// The meter in a line: what it came to ("at least" when some calls had no price, "at most" when one was counted at its
    /// most, "about" when both), against the budget.
    static func line(_ m: UsageMeter) -> String {
        // ("at least" where some calls had no price or reported nothing; "at most" where a handed task's was counted at its
        // most, its provider silent in time; never of $0.)
        let spent = "\(figure(m))\(usd(m.spentUsd))"
        guard let budget = m.budgetUsd else { return "\(spent) · \(tokens(m.tokens)) tokens" }
        guard let left = m.leftUsd, left > 0 else { return "\(spent) of \(usd(budget)) · spent" }
        return "\(spent) of \(usd(budget)) · \(usd(left)) left"
    }

    /// What the meter's figure is, in the word before it (core's boundWord): "", "at least ", "at most " or "about "; never
    /// of $0.
    static func figure(_ m: UsageMeter) -> String {
        m.spentUsd == 0 ? "" : Spend.boundWord(lower: !m.complete, upper: m.atMost == true)
    }

    /// The same, starting a line: "At most ", as the PWA's figure says it (lib/usage.ts spentWords).
    static func figureStarting(_ m: UsageMeter) -> String {
        let word = figure(m)
        return word.prefix(1).uppercased() + word.dropFirst()
    }

    /// How much of the budget is spent, 0 to 1 (nil with none).
    static func share(_ m: UsageMeter) -> Double? {
        guard let budget = m.budgetUsd, budget > 0 else { return nil }
        return min(1, m.spentUsd / budget)
    }

    static func period(_ m: UsageMeter) -> String { m.per == "day" ? "Today" : "This month" }

    /// A plan whose allowance is spent, in a line: whose, and until when by this device's clock (`invincible usage` says it
    /// in UTC; here it is the hour you'd read off your own phone).
    static func window(_ w: UsageMeter.SpentWindow, now: Date = .now, calendar: Calendar = .current, locale: Locale = .current) -> String {
        let until = Date(timeIntervalSince1970: w.until / 1000)
        let time = until.formatted(Date.FormatStyle(date: .omitted, time: .shortened, locale: locale, calendar: calendar, timeZone: calendar.timeZone))
        let tomorrow = calendar.date(byAdding: .day, value: 1, to: now).map { calendar.isDate(until, inSameDayAs: $0) } ?? false
        let day = calendar.isDate(until, inSameDayAs: now) ? "" : tomorrow ? " tomorrow" : until.formatted(Date.FormatStyle(locale: locale, calendar: calendar, timeZone: calendar.timeZone).weekday(.wide)).prefixed(" on ")
        return "\(w.provider): its allowance is spent until \(time)\(day)"
    }
}

private extension String {
    func prefixed(_ prefix: String) -> String { prefix + self }
}

/// The meter: this period's model calls at your prices against your budget, as a line and a thin bar that stand still;
/// a tap opens what they came to, and the budget to set. On the agents (an iPhone) and at a sidebar's foot.
struct UsageMeterView: View {
    let session: Session
    @State private var open = false

    var body: some View {
        if let meter = session.usage {
            Button { open = true } label: { UsageMeterLine(meter: meter) }
                .buttonStyle(.plain)
                .accessibilityHint("What your model calls came to, and your budget")
                .sheet(isPresented: $open) { UsageSheet(session: session) }
        }
    }
}

/// The meter's line and bar: in the ink while there's budget left, in its red once it's spent.
struct UsageMeterLine: View {
    let meter: UsageMeter

    private var spent: Bool { meter.budgetUsd != nil && (meter.leftUsd ?? 0) <= 0 }

    var body: some View {
        VStack(alignment: .leading, spacing: Space.s1) {
            HStack(alignment: .firstTextBaseline, spacing: Space.s2) {
                Label(Usage.period(meter), systemImage: "gauge.with.dots.needle.33percent")
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(.secondary)
                Spacer(minLength: Space.s2)
                Text(Usage.line(meter))
                    .font(.caption.monospacedDigit())
                    .foregroundStyle(spent ? AnyShapeStyle(Color.danger) : AnyShapeStyle(.primary))
                    .lineLimit(1)
                    .minimumScaleFactor(0.85)
            }
            if let share = Usage.share(meter) {
                UsageBar(share: share, spent: spent)
            }
            // A plan passed over until its allowance resets: why an agent's work is on another model meanwhile.
            ForEach(meter.windows ?? [], id: \.self) { window in
                Text(Usage.window(window)).font(.caption).foregroundStyle(.secondary)
            }
        }
        .contentShape(.rect)
        .accessibilityElement(children: .combine)
    }
}

/// A thin bar, filled as far as the budget is spent.
private struct UsageBar: View {
    let share: Double
    let spent: Bool

    var body: some View {
        GeometryReader { box in
            ZStack(alignment: .leading) {
                Capsule().fill(.fill.tertiary)
                Capsule().fill(spent ? Color.danger : Color.ink).frame(width: max(share > 0 ? 4 : 0, box.size.width * share))
            }
        }
        .frame(height: 5)
        .accessibilityHidden(true)
    }
}

/// What this period's calls came to: the meter large, what cost most, models with no price, and your budget to set.
struct UsageSheet: View {
    let session: Session
    @Environment(\.dismiss) private var dismiss
    /// The budget as the node holds it when the sheet opens, to change.
    @State private var amount: String
    @State private var per: String
    @State private var saving = false
    @State private var problem: String?

    init(session: Session) {
        self.session = session
        let meter = session.usage
        _per = State(initialValue: meter?.per == "day" ? "day" : "month")
        _amount = State(initialValue: meter?.budgetUsd.map { String(format: $0 < 10 ? "%.2f" : "%.0f", $0) } ?? "")
    }

    var body: some View {
        NavigationStack {
            List {
                if let meter = session.usage {
                    Section {
                        VStack(alignment: .leading, spacing: Space.s2) {
                            Text("\(Usage.figureStarting(meter))\(Usage.usd(meter.spentUsd))")
                                .font(.largeTitle.weight(.semibold).monospacedDigit())
                            Text(subline(meter)).font(.subheadline).foregroundStyle(.secondary)
                            if let share = Usage.share(meter) { UsageBar(share: share, spent: (meter.leftUsd ?? 0) <= 0) }
                        }
                        .padding(.vertical, Space.s2)
                    } footer: {
                        Text("Since \(meter.since) (UTC), on this node, at the prices you've set. \(Usage.tokens(meter.tokens)) tokens in \(meter.calls) call\(meter.calls == 1 ? "" : "s").")
                    }
                    if let windows = meter.windows, !windows.isEmpty {
                        Section {
                            ForEach(windows, id: \.self) { window in
                                VStack(alignment: .leading, spacing: Space.s1) {
                                    Text(Usage.window(window)).font(.callout)
                                    Text(window.said).font(.caption).foregroundStyle(.secondary).lineLimit(3)
                                }
                            }
                        } header: {
                            Text("Passed over until their allowance resets")
                        } footer: {
                            Text("Their models are skipped without asking until then, and the next on each role's list answers.")
                        }
                    }
                    if !meter.top.isEmpty {
                        Section("What cost most") {
                            ForEach(meter.top, id: \.self) { top in
                                HStack {
                                    Text(top.model).font(.callout.monospaced()).lineLimit(1).truncationMode(.middle)
                                    Spacer(minLength: Space.s2)
                                    Text(top.usd.map(Usage.usd) ?? "\(Usage.tokens(top.tokens)) tokens").font(.callout.monospacedDigit()).foregroundStyle(.secondary)
                                }
                            }
                        }
                    }
                    if !meter.unpriced.isEmpty {
                        Section {
                            Label("No price for \(meter.unpriced.joined(separator: ", ")): \(meter.unpriced.count == 1 ? "its" : "their") tokens aren't in this. Set one with invincible price set.", systemImage: "info.circle")
                                .font(.footnote)
                                .foregroundStyle(.secondary)
                        }
                    }
                }
                if session.can("brain:write") {
                    Section {
                        Picker("Per", selection: $per) {
                            Text("Day").tag("day")
                            Text("Month").tag("month")
                        }
                        .pickerStyle(.segmented)
                        HStack {
                            Text("US dollars")
                            TextField("No budget", text: $amount)
                                .multilineTextAlignment(.trailing)
                                .monospacedDigit()
                                #if os(iOS)
                                .keyboardType(.decimalPad)
                                #endif
                        }
                        if let problem { Text(problem).font(.footnote).foregroundStyle(Color.danger) }
                    } header: {
                        Text("Your budget")
                    } footer: {
                        Text("A line to watch, never a stop: work goes on past it. A task's own budget is what stops a task.")
                    }
                }
            }
            .navigationTitle("Usage")
            .inlineTitle()
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Close") { dismiss() } }
                if session.can("brain:write") {
                    ToolbarItem(placement: .confirmationAction) {
                        Button("Save") { Task { await save() } }.disabled(saving)
                    }
                }
            }
        }
        #if os(macOS)
        .frame(minWidth: 420, minHeight: 480)
        #endif
    }

    private func subline(_ m: UsageMeter) -> String {
        let period = m.per == "day" ? "today" : "this month"
        guard let budget = m.budgetUsd else { return "spent \(period), with no budget" }
        if let left = m.leftUsd, left > 0 { return "of \(Usage.usd(budget)) \(period): \(Usage.usd(left)) left" }
        return "of \(Usage.usd(budget)) \(period): spent"
    }

    private func save() async {
        let typed = amount.trimmingCharacters(in: .whitespaces).replacingOccurrences(of: ",", with: ".").replacingOccurrences(of: "$", with: "")
        let usd: Double? = typed.isEmpty ? nil : Double(typed)
        if !typed.isEmpty, (usd ?? 0) <= 0 || (usd ?? 0) > 100_000 {
            problem = "A budget is an amount in US dollars above 0, like 25, or empty for none."
            return
        }
        saving = true
        defer { saving = false }
        do {
            try await session.setBudget(usd: usd, per: per)
            dismiss()
        } catch {
            problem = error.localizedDescription
        }
    }
}
