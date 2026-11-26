import Foundation
import Testing
@testable import Invincible

/// The meter's words, as the node's own say money and tokens (core's spend.ts: usdLabel, tokensLabel).
struct UsageTests {
    private func meter(spent: Double, budget: Double?, left: Double?, complete: Bool = true, per: String = "month") -> UsageMeter {
        UsageMeter(per: per, since: "2026-11-01", budgetUsd: budget, spentUsd: spent, complete: complete, unpriced: [], tokens: 3_610_000, calls: 3, leftUsd: left, top: [])
    }

    @Test func moneyAndTokensReadAsTheNodesDo() {
        #expect(Usage.usd(0) == "$0")
        #expect(Usage.usd(0.005) == "$0.0050")
        #expect(Usage.usd(3.4) == "$3.40")
        #expect(Usage.usd(10) == "$10.0")
        #expect(Usage.usd(150) == "$150")
        #expect(Usage.tokens(9_999) == "9,999")
        #expect(Usage.tokens(48_210) == "48.2k")
        #expect(Usage.tokens(2_340_000) == "2.34M")
    }

    @Test func aSpentPlanIsSaidWithTheHourItResetsOnThisDevicesClock() throws {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = try #require(TimeZone(identifier: "Europe/Copenhagen"))
        let locale = Locale(identifier: "en_GB")
        // 21 November 2026, 13:00 in Copenhagen (12:00 UTC).
        let now = Date(timeIntervalSince1970: 1_795_262_400)
        let window = { (hoursOn: Double) in UsageMeter.SpentWindow(provider: "opencode-go", until: (1_795_262_400 + hoursOn * 3600) * 1000, said: "allowance spent; resets in 35h") }
        // The hour as this device's clock writes it (how a locale writes 01:00 differs between OS versions).
        let hour = { (hoursOn: Double) in Date(timeIntervalSince1970: 1_795_262_400 + hoursOn * 3600).formatted(Date.FormatStyle(date: .omitted, time: .shortened, locale: locale, calendar: calendar, timeZone: calendar.timeZone)) }
        // Five hours on is 18:00 in Copenhagen (17:00 UTC): the phone's own clock, not the node's.
        #expect(hour(5) == "18:00")
        #expect(Usage.window(window(5), now: now, calendar: calendar, locale: locale) == "opencode-go: its allowance is spent until 18:00")
        #expect(Usage.window(window(12), now: now, calendar: calendar, locale: locale) == "opencode-go: its allowance is spent until \(hour(12)) tomorrow")
        #expect(Usage.window(window(60), now: now, calendar: calendar, locale: locale) == "opencode-go: its allowance is spent until \(hour(60)) on Tuesday")
    }

    @Test func aMeterFromANodeThatSaysNoWindowsHasNone() throws {
        let older = #"{"per":"month","since":"2026-11-01","budgetUsd":null,"spentUsd":1.5,"complete":true,"unpriced":[],"tokens":10,"calls":1,"leftUsd":null,"top":[]}"#
        #expect(try JSONDecoder().decode(UsageMeter.self, from: Data(older.utf8)).windows == nil)
        let spent = #"{"per":"month","since":"2026-11-01","budgetUsd":null,"spentUsd":1.5,"complete":true,"unpriced":[],"tokens":10,"calls":1,"leftUsd":null,"top":[],"windows":[{"provider":"opencode-go","until":1795390200000,"said":"resets in 35h"}]}"#
        #expect(try JSONDecoder().decode(UsageMeter.self, from: Data(spent.utf8)).windows == [UsageMeter.SpentWindow(provider: "opencode-go", until: 1_795_390_200_000, said: "resets in 35h")])
    }

    @Test func theLineSaysWhatIsLeftOrThatItIsSpent() {
        #expect(Usage.line(meter(spent: 3.4, budget: 10, left: 6.6, complete: false)) == "at least $3.40 of $10.0 · $6.60 left")
        #expect(Usage.line(meter(spent: 2.1, budget: 2, left: 0)) == "$2.10 of $2.00 · spent")
        #expect(Usage.line(meter(spent: 3.4, budget: nil, left: nil)) == "$3.40 · 3.61M tokens")
        // Nothing priced yet is $0, never "at least $0".
        #expect(Usage.line(meter(spent: 0, budget: nil, left: nil, complete: false)) == "$0 · 3.61M tokens")
        #expect(Usage.share(meter(spent: 15, budget: 10, left: 0)) == 1)
        #expect(Usage.share(meter(spent: 3, budget: nil, left: nil)) == nil)
    }
}
