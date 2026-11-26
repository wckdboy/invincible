import Charts
import SwiftUI
import WebKit

extension EnvironmentValues {
    /// Sends a choice it offered as your reply: set only on its latest finished answer.
    @Entry var choose: ((String) -> Void)? = nil
    /// The answer is still being written: a page waits until it's whole.
    @Entry var answerLive = false
}

/// A fenced block its answer holds, drawn as what it is (core's blocks.ts, the PWA's ui/blocks.ts): a chart, figures,
/// choices to tap, a plan's steps, a page. One still being written is a placeholder (a chart's and a page's as big as
/// what replaces it, so the answer doesn't jump when it's drawn); one its reader won't take is shown as the code it is,
/// with why.
struct AnswerBlock: View {
    let kind: Blocks.Kind
    let text: String
    let open: Bool
    @Environment(\.answerLive) private var live

    var body: some View {
        if open {
            switch kind {
            case .chart: ChartPending()
            case .artifact: PageBlock(page: text, waiting: true)
            default: Pending(kind: kind)
            }
        } else {
            switch kind {
            case .chart:
                switch Blocks.chart(text) {
                case .ok(let spec): ChartBlock(spec: spec)
                case .no(let why): Refused(what: "chart", why: why, kind: kind, text: text)
                }
            case .stats:
                switch Blocks.stats(text) {
                case .ok(let stats): StatsBlock(stats: stats)
                case .no(let why): Refused(what: "figures", why: why, kind: kind, text: text)
                }
            case .choices:
                switch Blocks.choices(text) {
                case .ok(let choices): ChoicesBlock(choices: choices)
                case .no(let why): Refused(what: "choices", why: why, kind: kind, text: text)
                }
            case .steps:
                switch Blocks.steps(text) {
                case .ok(let steps): StepsBlock(steps: steps)
                case .no(let why): Refused(what: "steps", why: why, kind: kind, text: text)
                }
            case .artifact:
                switch Blocks.artifact(text) {
                case .ok(let page): PageBlock(page: page, waiting: live)
                case .no(let why): Refused(what: "page", why: why, kind: kind, text: text)
                }
            }
        }
    }
}

private struct Pending: View {
    let kind: Blocks.Kind

    var body: some View {
        let (symbol, words): (String, String) = switch kind {
        case .chart: ("chart.xyaxis.line", "Drawing a chart…")
        case .stats: ("gauge.with.needle", "Gathering figures…")
        case .choices: ("bubble.left.and.text.bubble.right", "Writing choices…")
        case .steps: ("list.number", "Planning steps…")
        case .artifact: ("doc.richtext", "Making a page: it opens when it's done")
        }
        Label(words, systemImage: symbol)
            .font(.subheadline)
            .foregroundStyle(.secondary)
            .padding(Space.s3)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(.fill.quaternary, in: .rect(cornerRadius: Metrics.innerRadius, style: .continuous))
            .accessibilityAddTraits(.updatesFrequently)
    }
}

/// A chart still being written, laid out as the chart will be (its title's line, its plot, its data folded under it),
/// so nothing under it moves when it's drawn.
private struct ChartPending: View {
    var body: some View {
        VStack(alignment: .leading, spacing: Space.s2) {
            Label("Drawing a chart…", systemImage: "chart.xyaxis.line").font(.subheadline.weight(.semibold)).foregroundStyle(.secondary)
            RoundedRectangle(cornerRadius: Metrics.innerRadius, style: .continuous)
                .fill(.fill.quaternary)
                .frame(height: ChartBlock.plotHeight)
            DisclosureGroup(isExpanded: .constant(false)) {
                EmptyView()
            } label: {
                Text("The data").font(.caption).foregroundStyle(.secondary)
            }
            .disabled(true)
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("Drawing a chart…")
        .accessibilityAddTraits(.updatesFrequently)
    }
}

private struct Refused: View {
    let what: String
    let why: String
    let kind: Blocks.Kind
    let text: String

    var body: some View {
        VStack(alignment: .leading, spacing: Space.s2) {
            Text("This \(what) couldn't be drawn: \(why).").font(.caption).foregroundStyle(.secondary)
            CodeBlock(lang: kind.rawValue, text: text)
        }
    }
}

// MARK: - A chart

/// Six colours in a fixed order, as the PWA's (validated there for colour-blind separation on both themes' surfaces).
enum Palette {
    static let series: [Color] = [
        pair(0x2A78D6, 0x3987E5), pair(0xEB6834, 0xD95926), pair(0x1BAF7A, 0x199E70),
        pair(0xEDA100, 0xC98500), pair(0xE87BA4, 0xD55181), pair(0x008300, 0x008300),
    ]

    private static func pair(_ light: UInt32, _ dark: UInt32) -> Color { Color(light: light, dark: dark) }
}

/// Clean round ticks over [lo, hi], about `count` of them (the PWA's niceTicks).
func niceTicks(_ low: Double, _ high: Double, count: Double = 4) -> [Double] {
    var (lo, hi) = (low, high)
    if lo == hi { (lo, hi) = lo == 0 ? (0, 1) : (min(0, lo), max(0, hi)) }
    let rough = (hi - lo) / count
    let magnitude = pow(10, floor(log10(rough)))
    let step = magnitude * ([1, 2, 2.5, 5, 10].first { rough / magnitude <= $0 } ?? 10)
    var ticks: [Double] = []
    var v = floor(lo / step) * step
    while v <= hi + step * 1e-9 {
        ticks.append(Double(String(format: "%.12g", v)) ?? v)
        v += step
    }
    if let last = ticks.last, last < hi { ticks.append(Double(String(format: "%.12g", last + step)) ?? last + step) }
    return ticks
}

/// The values a chart spans: a bar grows from zero, so does a stack (its totals) and an area; a line may float.
func domainOf(_ spec: Blocks.Chart) -> (Double, Double) {
    let values: [Double] = spec.type == .stacked
        ? spec.labels.indices.map { i in spec.series.reduce(0) { $0 + ($1.values[i] ?? 0) } }
        : spec.series.flatMap { $0.values.compactMap { $0 } }
    var lo = values.min() ?? 0, hi = values.max() ?? 1
    if spec.type != .line { (lo, hi) = (min(0, lo), max(0, hi)) } else if lo > 0, lo / hi < 0.35 { lo = 0 }
    return (lo, hi)
}

private struct ChartBlock: View {
    /// How tall its plot is, drawn or still to come.
    static let plotHeight: CGFloat = 200

    let spec: Blocks.Chart
    @State private var selected: String?
    @State private var showingData = false

    private struct Point: Identifiable {
        let id: String
        /// The category: a label's position, so two labels alike stay apart.
        let at: String
        let series: String
        /// A run of values without a gap: a line breaks where one is missing.
        let run: String
        let value: Double
    }

    private var points: [Point] {
        spec.series.flatMap { series in
            var run = 0
            return series.values.enumerated().compactMap { index, value -> Point? in
                guard let value else {
                    run += 1
                    return nil
                }
                return Point(id: "\(series.name)#\(index)", at: "\(index)", series: series.name, run: "\(series.name)#\(run)", value: value)
            }
        }
    }

    private var ticks: [Double] {
        let (lo, hi) = domainOf(spec)
        return niceTicks(lo, hi)
    }

    /// Every label when they fit; else every few, evenly.
    private var shownLabels: [String] {
        let every = max(1, Int((Double(spec.labels.count) / 6).rounded(.up)))
        return spec.labels.indices.filter { $0 % every == 0 }.map(String.init)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: Space.s2) {
            if spec.title != nil || spec.unit != nil {
                HStack(alignment: .firstTextBaseline) {
                    if let title = spec.title { Text(title).font(.subheadline.weight(.semibold)) }
                    Spacer()
                    if let unit = spec.unit { Text(unit).font(.caption).foregroundStyle(.secondary) }
                }
            }
            Chart {
                ForEach(points) { point in mark(point) }
                if let selected, let index = Int(selected), spec.labels.indices.contains(index) {
                    RuleMark(x: .value("At", selected))
                        .foregroundStyle(.secondary.opacity(0.35))
                        .annotation(position: .top, spacing: Space.s1, overflowResolution: .init(x: .fit(to: .chart), y: .disabled)) {
                            readout(index)
                        }
                }
            }
            .chartForegroundStyleScale(domain: spec.series.map(\.name), range: Array(Palette.series.prefix(spec.series.count)))
            .chartLegend(spec.series.count > 1 ? .visible : .hidden)
            .chartLegend(position: .top, alignment: .leading)
            .chartYScale(domain: (ticks.first ?? 0)...(ticks.last ?? 1))
            .chartYAxis {
                AxisMarks(position: .leading, values: ticks) { value in
                    AxisGridLine(stroke: StrokeStyle(lineWidth: 0.5)).foregroundStyle(.secondary.opacity(0.3))
                    AxisValueLabel { if let n = value.as(Double.self) { Text(Blocks.compactNumber(n)) } }
                }
            }
            .chartXAxis {
                AxisMarks(values: shownLabels) { value in
                    AxisValueLabel { if let at = value.as(String.self), let index = Int(at) { Text(spec.labels[index]).lineLimit(1) } }
                }
            }
            .chartXSelection(value: $selected)
            .frame(height: Self.plotHeight)
            .accessibilityLabel(spec.title ?? "A chart")
            DisclosureGroup(isExpanded: $showingData) {
                dataTable.padding(.top, Space.s2)
            } label: {
                Text("The data").font(.caption).foregroundStyle(.secondary)
            }
        }
    }

    @ChartContentBuilder private func mark(_ point: Point) -> some ChartContent {
        switch spec.type {
        case .line:
            LineMark(x: .value("At", point.at), y: .value("Value", point.value), series: .value("Run", point.run))
                .foregroundStyle(by: .value("Series", point.series))
                .lineStyle(StrokeStyle(lineWidth: 2, lineCap: .round, lineJoin: .round))
                .symbol(.circle)
                .symbolSize(24)
        case .area:
            AreaMark(x: .value("At", point.at), y: .value("Value", point.value), series: .value("Run", point.run), stacking: .unstacked)
                .foregroundStyle(by: .value("Series", point.series))
                .opacity(0.35)
        case .bar:
            BarMark(x: .value("At", point.at), y: .value("Value", point.value))
                .foregroundStyle(by: .value("Series", point.series))
                .position(by: .value("Series", point.series))
                .cornerRadius(3)
        case .stacked:
            BarMark(x: .value("At", point.at), y: .value("Value", point.value))
                .foregroundStyle(by: .value("Series", point.series))
                .cornerRadius(2)
        }
    }

    /// What each series reads at the label you touched.
    private func readout(_ index: Int) -> some View {
        VStack(alignment: .leading, spacing: Space.line) {
            Text(spec.labels[index]).font(.caption.weight(.semibold))
            ForEach(Array(spec.series.enumerated()), id: \.offset) { position, series in
                HStack(spacing: Space.s2) {
                    Circle().fill(Palette.series[position % Palette.series.count]).frame(width: 7, height: 7)
                    Text(series.name).foregroundStyle(.secondary)
                    Spacer(minLength: Space.s2)
                    Text(series.values[index].map { Blocks.withUnit(Blocks.compactNumber($0), spec.unit) } ?? "–").monospacedDigit()
                }
                .font(.caption)
            }
        }
        .padding(Space.s2)
        .frame(minWidth: 120)
        .background(.regularMaterial, in: .rect(cornerRadius: Metrics.innerRadius, style: .continuous))
    }

    private var dataTable: some View {
        ScrollView(.horizontal) {
            Grid(alignment: .trailing, horizontalSpacing: Space.s3, verticalSpacing: Space.s1) {
                GridRow {
                    Text("").gridColumnAlignment(.leading)
                    ForEach(Array(spec.series.enumerated()), id: \.offset) { _, series in Text(series.name).fontWeight(.semibold) }
                }
                ForEach(Array(spec.labels.enumerated()), id: \.offset) { index, label in
                    GridRow {
                        Text(label).foregroundStyle(.secondary)
                        ForEach(Array(spec.series.enumerated()), id: \.offset) { _, series in
                            Text(series.values[index].map { Blocks.withUnit(Blocks.compactNumber($0), spec.unit) } ?? "–").monospacedDigit()
                        }
                    }
                }
            }
            .font(.caption)
            .fixedSize()
        }
    }
}

// MARK: - Figures

private struct StatsBlock: View {
    let stats: [Blocks.Stat]

    var body: some View {
        // Two a row: a phone's width holds two figures side by side.
        Grid(alignment: .topLeading, horizontalSpacing: Space.s2, verticalSpacing: Space.s2) {
            ForEach(Array(stride(from: 0, to: stats.count, by: 2)), id: \.self) { start in
                GridRow {
                    ForEach(start..<min(start + 2, stats.count), id: \.self) { index in
                        StatView(stat: stats[index])
                    }
                }
            }
        }
    }
}

private struct StatView: View {
    let stat: Blocks.Stat

    private enum Tone { case good, bad, neutral }

    private var tone: Tone {
        guard let delta = stat.delta, delta != 0, let good = stat.good else { return .neutral }
        return (delta > 0) == (good == "up") ? .good : .bad
    }

    private var shown: String {
        switch stat.value {
        case .number(let n): Blocks.compactNumber(n)
        case .text(let text): text
        }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: Space.s1) {
            Text(stat.label).font(.caption).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
            HStack(alignment: .firstTextBaseline, spacing: Space.s1) {
                Text(shown).font(.title2.weight(.semibold)).monospacedDigit()
                if let unit = stat.unit, case .number = stat.value { Text(unit).font(.subheadline).foregroundStyle(.secondary) }
            }
            if let delta = stat.delta {
                // One run of text, so a note wraps under the change rather than being cut short.
                let arrow = delta == 0 ? Text("") : Text("\(Image(systemName: delta > 0 ? "arrow.up" : "arrow.down")) ")
                let change = Text("\(delta > 0 ? "+" : delta < 0 ? "−" : "±")\(Blocks.withUnit(Blocks.compactNumber(abs(delta)), stat.unit))")
                let note = Text(stat.note.map { " \($0)" } ?? "").foregroundStyle(.secondary)
                Text("\(arrow)\(change)\(note)")
                    .font(.caption)
                    // Better in the ink, worse in the ink too, by its arrow: monochrome (red is for what went wrong, and a
                    // figure that moved the wrong way didn't go wrong).
                    .foregroundStyle(tone == .good || tone == .bad ? AnyShapeStyle(.primary) : AnyShapeStyle(.secondary))
                    .fixedSize(horizontal: false, vertical: true)
            } else if let note = stat.note {
                Text(note).font(.caption).foregroundStyle(.secondary)
            }
        }
        .padding(Space.s3)
        // As tall as the other figure in its row.
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        .background(.fill.quaternary, in: .rect(cornerRadius: Metrics.innerRadius, style: .continuous))
        .accessibilityElement(children: .combine)
        .accessibilityHint(tone == .good ? "Good" : tone == .bad ? "Not good" : "")
    }
}

// MARK: - Choices

private struct ChoicesBlock: View {
    let choices: [String]
    @Environment(\.choose) private var choose
    @State private var chosen: String?

    var body: some View {
        VStack(alignment: .leading, spacing: Space.s2) {
            ForEach(choices, id: \.self) { choice in
                Button {
                    chosen = choice
                    choose?(choice)
                } label: {
                    Text(choice).multilineTextAlignment(.leading)
                }
                .buttonStyle(.bordered)
                .buttonBorderShape(.capsule)
                // While its answer is still coming, or once one after it has: what it offered, the same size as when
                // it's yours to tap, so nothing moves when it becomes one.
                .disabled(choose == nil || chosen != nil)
                .accessibilityAddTraits(chosen == choice ? .isSelected : [])
            }
        }
        .accessibilityElement(children: .contain)
        .accessibilityLabel(choose == nil ? "What it offered" : "Answer with one")
    }
}

// MARK: - A plan's steps

private struct StepsBlock: View {
    let steps: [Blocks.Step]

    var body: some View {
        VStack(alignment: .leading, spacing: Space.s2) {
            ForEach(Array(steps.enumerated()), id: \.offset) { _, step in
                HStack(alignment: .firstTextBaseline, spacing: Space.s2) {
                    Image(systemName: Self.symbol[step.state] ?? "circle").foregroundStyle(color(step.state))
                    Text(step.text)
                        .strikethrough(step.state == .skipped)
                        .foregroundStyle(step.state == .skipped ? .secondary : .primary)
                        .fixedSize(horizontal: false, vertical: true)
                }
                .accessibilityElement(children: .ignore)
                .accessibilityLabel("\(Self.said[step.state] ?? ""): \(step.text)")
            }
        }
    }

    static let symbol: [Blocks.Step.State: String] = [.done: "checkmark.circle.fill", .doing: "play.circle.fill", .todo: "circle", .failed: "xmark.circle.fill", .skipped: "minus.circle"]
    static let said: [Blocks.Step.State: String] = [.done: "Done", .doing: "Doing now", .todo: "To do", .failed: "Failed", .skipped: "Skipped"]

    private func color(_ state: Blocks.Step.State) -> Color {
        switch state {
        case .done: .ink
        case .doing: .danger
        case .failed: .danger
        case .todo, .skipped: .secondary
        }
    }
}

// MARK: - A page

private struct PageBlock: View {
    /// How tall the page is shown in the answer, drawn or still to come.
    static let height: CGFloat = 260

    let page: String
    /// Still being written: its frame as it will be, with nothing in it yet and nothing to press.
    var waiting = false
    @State private var run = false
    @State private var showingCode = false
    @State private var full = false
    @State private var copied = false

    private var title: String { Blocks.artifactTitle(page) ?? "A page it made" }

    var body: some View {
        VStack(alignment: .leading, spacing: Space.s2) {
            HStack(spacing: Space.s3) {
                Label(title, systemImage: "doc.richtext").font(.subheadline.weight(.semibold)).lineLimit(1).layoutPriority(1)
                Spacer(minLength: 0)
                if !showingCode {
                    Button { run.toggle() } label: { Label(run ? "Stop" : "Run", systemImage: run ? "stop.fill" : "play.fill").font(.subheadline) }
                }
                // The rest a tap away, so its title has the line.
                Menu {
                    Button { showingCode.toggle() } label: {
                        Label(showingCode ? "Show the page" : "Its code", systemImage: "chevron.left.forwardslash.chevron.right")
                    }
                    Button { full = true } label: { Label("Open full screen", systemImage: "arrow.up.left.and.arrow.down.right") }
                    Button {
                        Pasteboard.copy(page)
                        copied = true
                    } label: { Label(copied ? "Copied" : "Copy its HTML", systemImage: copied ? "checkmark" : "doc.on.doc") }
                } label: {
                    Image(systemName: "ellipsis.circle")
                }
                .accessibilityLabel("More for this page")
            }
            .buttonStyle(.borderless)
            .disabled(waiting)
            if showingCode {
                CodeBlock(lang: "html", text: page)
            } else {
                Group {
                    if waiting {
                        Label("Making a page: it opens when it's done", systemImage: "doc.richtext")
                            .font(.subheadline)
                            .foregroundStyle(.secondary)
                            .padding(Space.s3)
                            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
                            .background(.fill.quaternary)
                            .accessibilityAddTraits(.updatesFrequently)
                    } else {
                        PageFrame(page: page, run: run, scrolls: false).id(run)
                    }
                }
                .frame(height: Self.height)
                .clipShape(.rect(cornerRadius: Metrics.innerRadius, style: .continuous))
                .overlay(RoundedRectangle(cornerRadius: Metrics.innerRadius, style: .continuous).strokeBorder(.secondary.opacity(0.25)))
            }
            Text(run ? "Running its own code, sealed off from \(Primary.name) and your data: it can't fetch anything or open another page." : "Shown as it is: its scripts don't run until you press Run, and nothing loads from the network.")
                .font(.caption)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
        }
        .sheet(isPresented: $full) {
            NavigationStack {
                PageFrame(page: page, run: run, scrolls: true)
                    .ignoresSafeArea(edges: .bottom)
                    .navigationTitle(title)
                    .inlineTitle()
                    .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { full = false } } }
            }
            .sheetSize(width: 900, height: 700)
        }
        .task(id: copied) {
            guard copied else { return }
            try? await Task.sleep(for: .seconds(2))
            copied = false
        }
    }
}

/**
 * A page it made, sealed off as the PWA seals its frame: its own process with nothing kept (no cookies, no storage that
 * outlives it), a policy that lets nothing load but what the page carries inline, every web load blocked again by a
 * content rule, no window it may open, and no navigation but its own first load. Its scripts run only once you press
 * Run.
 */
struct PageFrame {
    let page: String
    let run: Bool
    /// In the chat the page stays put, so a finger over it scrolls the chat; full screen, it scrolls.
    let scrolls: Bool

    @MainActor func makeCoordinator() -> Coordinator { Coordinator() }

    /// The sealed page's view, the same on both platforms (only how SwiftUI holds it differs, below).
    @MainActor private func make(_ coordinator: Coordinator) -> WKWebView {
        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = .nonPersistent()
        configuration.defaultWebpagePreferences.allowsContentJavaScript = run
        configuration.preferences.javaScriptCanOpenWindowsAutomatically = false
        #if os(iOS)
        configuration.dataDetectorTypes = []
        let view = WKWebView(frame: .zero, configuration: configuration)
        #else
        let view = PageView(frame: .zero, configuration: configuration)
        view.scrolls = scrolls
        #endif
        view.navigationDelegate = coordinator
        view.uiDelegate = coordinator
        view.isInspectable = false
        #if os(iOS)
        view.scrollView.isScrollEnabled = scrolls
        #endif
        let html = Self.framed(page, run: run)
        // Only once the rule that blocks every web load is in place.
        Task { @MainActor in
            guard let rules = await Self.rules() else { return }
            view.configuration.userContentController.add(rules)
            view.loadHTMLString(html, baseURL: nil)
        }
        return view
    }

    /// The page's HTML as it's loaded: the PWA's `framed`. Our head comes first, and holds for what follows.
    static func framed(_ page: String, run: Bool) -> String {
        let policy = "default-src 'none'; img-src data: blob:; media-src data: blob:; style-src 'unsafe-inline'; font-src data:; base-uri 'none'; form-action 'none'" + (run ? "; script-src 'unsafe-inline'" : "")
        let unlinked = page.replacingOccurrences(of: "<link\\b[^>]*>", with: "", options: [.regularExpression, .caseInsensitive])
        return "<!doctype html><meta charset=\"utf-8\"><meta http-equiv=\"Content-Security-Policy\" content=\"\(policy)\"><meta http-equiv=\"x-dns-prefetch-control\" content=\"off\"><meta name=\"referrer\" content=\"no-referrer\"><meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">\(unlinked)"
    }

    @MainActor private static var compiled: WKContentRuleList?

    /// Every web load blocked (http, https, ws, wss), compiled once.
    @MainActor static func rules() async -> WKContentRuleList? {
        if let compiled { return compiled }
        let blockWeb = #"[{"trigger":{"url-filter":"^https?:"},"action":{"type":"block"}},{"trigger":{"url-filter":"^wss?:"},"action":{"type":"block"}}]"#
        compiled = try? await WKContentRuleListStore.default().compileContentRuleList(forIdentifier: "invincible-sealed-page", encodedContentRuleList: blockWeb)
        return compiled
    }

    @MainActor final class Coordinator: NSObject, WKNavigationDelegate, WKUIDelegate {
        private var loaded = false

        /// Its own first load, and nothing after: no link, refresh or script takes it anywhere.
        func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction) async -> WKNavigationActionPolicy {
            guard !loaded, action.targetFrame?.isMainFrame != false, action.request.url?.scheme == "about" else { return .cancel }
            loaded = true
            return .allow
        }

        func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration, for action: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? { nil }
    }
}

#if os(iOS)
extension PageFrame: UIViewRepresentable {
    func makeUIView(context: Context) -> WKWebView { make(context.coordinator) }
    func updateUIView(_ view: WKWebView, context: Context) {}
}
#else
extension PageFrame: NSViewRepresentable {
    func makeNSView(context: Context) -> WKWebView { make(context.coordinator) }
    func updateNSView(_ view: WKWebView, context: Context) {}

    /// A Mac's web view scrolls its page under the pointer whatever it is in; in the chat the page stays put and the
    /// wheel scrolls the chat, as a finger over it does on an iPhone.
    final class PageView: WKWebView {
        var scrolls = true
        override func scrollWheel(with event: NSEvent) {
            if scrolls { super.scrollWheel(with: event) } else { nextResponder?.scrollWheel(with: event) }
        }
    }
}
#endif
