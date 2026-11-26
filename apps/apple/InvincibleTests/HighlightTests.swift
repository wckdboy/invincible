import Testing
@testable import Invincible

/// Code is coloured here as the PWA colours it (lib/highlight.ts, through the vectors).
struct HighlightTests {
    @Test func eachSampleIsColouredAsThePWAColoursIt() {
        for sample in Vectors.shared.highlights {
            let pieces = Highlight.pieces(sample.code, lang: sample.lang)
            #expect(pieces.map(\.text) == sample.pieces.map(\.text), "\(sample.lang): \(sample.code)")
            #expect(pieces.map { $0.tone?.rawValue } == sample.pieces.map(\.tone), "\(sample.lang): \(sample.code)")
            // Nothing is ever lost or added.
            #expect(pieces.map(\.text).joined() == sample.code)
        }
        #expect(Vectors.shared.highlights.count >= 16)
    }
}

/// A diff in its files' parts, and a file's language by its name.
struct DiffPartsTests {
    @Test func aDiffIsItsFilesParts() {
        let diff = "diff --git a/sync.ts b/sync.ts\nindex 1..2\n--- a/sync.ts\n+++ b/sync.ts\n@@ -1 +1 @@\n-a\n+b\ndiff --git a/my notes.md b/my notes.md\nnew file mode 100644\n+hi\n"
        let parts = DiffParts.of(diff)
        #expect(parts.map(\.path) == ["sync.ts", "my notes.md"])
        #expect(parts[0].text == "diff --git a/sync.ts b/sync.ts\nindex 1..2\n--- a/sync.ts\n+++ b/sync.ts\n@@ -1 +1 @@\n-a\n+b")
        #expect(parts[1].text.hasSuffix("+hi\n"))
        #expect(DiffParts.of("").isEmpty)
    }

    @Test func aFilesLanguageIsByItsName() {
        #expect(DiffParts.language(of: "/work/src/app.ts") == "ts")
        #expect(DiffParts.language(of: "config.YML") == "yaml")
        #expect(DiffParts.language(of: "README.md") == "")
        #expect(DiffParts.language(of: "Dockerfile") == "sh")
        #expect(DiffParts.language(of: ".env") == "")
    }
}
