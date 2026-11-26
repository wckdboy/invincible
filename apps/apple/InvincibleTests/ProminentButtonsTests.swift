import Foundation
import Testing

/// A prominent button's ground is the ink, so its words must be the ink's own colour (`Prominent.label`): left to the
/// glass style, "Turn on notifications" was cream on its cream ground in dark mode (26 November 2026). The app's
/// sources are read as they are, so a new prominent button without it fails here.
struct ProminentButtonsTests {
    @Test func everyProminentButtonsWordsAreTheInksOwnColour() throws {
        let app = URL(filePath: #filePath).deletingLastPathComponent().appending(path: "../Invincible")
        let files = try #require(FileManager.default.enumerator(at: app, includingPropertiesForKeys: nil)?.allObjects as? [URL])
        var bare: [String] = []
        var seen = 0
        for file in files where file.pathExtension == "swift" {
            let lines = try String(contentsOf: file, encoding: .utf8).components(separatedBy: "\n")
            for (i, line) in lines.enumerated() where line.contains(".buttonStyle(.glassProminent)") {
                seen += 1
                // The button's label is written within the few lines before its style.
                let label = lines[max(0, i - 8)..<i].joined(separator: "\n")
                if !label.contains("Prominent.label") { bare.append("\(file.lastPathComponent):\(i + 1)") }
            }
        }
        #expect(seen >= 10, "the app's prominent buttons were found")
        #expect(bare.isEmpty, "prominent buttons whose words don't take Prominent.label: \(bare)")
    }
}
