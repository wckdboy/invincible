import Foundation

/// When, as the list that is home says it, as a chat app's list does (apps/web/src/lib/time.ts listTime, held to its
/// vectors): today, its clock time ("14:05"); "Yesterday"; the weekday's name two to six days back ("Thursday"); else the
/// date in numbers with its whole year ("21/11/2026"). Days are the calendar's in the zone, not 24-hour spans, so half
/// past midnight is today's; a day ahead (a clock running fast) is a date too.
enum ListTime {
    static func words(_ ms: Double, now: Double, zone: TimeZone = .current, device: Locale = .autoupdatingCurrent) -> String {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = zone
        let at = Date(timeIntervalSince1970: ms / 1000)
        let today = calendar.startOfDay(for: Date(timeIntervalSince1970: now / 1000))
        let days = calendar.dateComponents([.day], from: calendar.startOfDay(for: at), to: today).day ?? 0
        let style = Date.FormatStyle(locale: speaking(device), calendar: calendar, timeZone: zone)
        switch days {
        // (The locale's hour and minute, as the web's short time: "08:04" in Britain, "8:04 AM" in America. The
        // style's own `.shortened` drops the British hour's zero.)
        case 0: return at.formatted(style.hour().minute())
        case 1: return "Yesterday"
        case 2...6: return at.formatted(style.weekday(.wide))
        default: return at.formatted(style.year().month(.defaultDigits).day())
        }
    }

    /// The locale the list's times are said in (lib/time.ts listLocale): the app's language, English (every word of it
    /// is), with the device's region, and its clock where you set it to 24 hours or 12. So "Yesterday" and a weekday's
    /// name are English while the clock and the date are written as that region writes them: a phone in Danish says
    /// "Thursday", "14.05", "21/11/2026", never "torsdag" beside "Yesterday". (A locale that names no region is given its
    /// language's likeliest, as the web's does.)
    static func speaking(_ device: Locale) -> Locale {
        let region = device.region ?? Locale.Language(identifier: device.language.maximalIdentifier).region
        var parts = Locale.Components(languageCode: .english, script: nil, languageRegion: region)
        let plain = Locale(components: parts)
        guard device.hourCycle != plain.hourCycle else { return plain }
        parts.hourCycle = device.hourCycle
        return Locale(components: parts)
    }
}
