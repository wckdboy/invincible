import Foundation
import Testing
@testable import Invincible

/// What an answer may show beyond words is read as core reads it (`packages/core/src/blocks.ts`): the same chart, figures,
/// choices, steps and pages taken, the same refused with the same words, and its numbers written alike.
struct BlocksTests {
    let blocks = Vectors.shared.blocks

    @Test func chartsAreReadAsCoreReadsThem() {
        for item in blocks.charts {
            switch (Blocks.chart(item.text), item.read) {
            case (.ok(let mine), .ok(let core)):
                #expect(mine.type.rawValue == core.type, "\(item.text)")
                #expect(mine.title == core.title && mine.unit == core.unit && mine.labels == core.labels, "\(item.text)")
                #expect(mine.series.map(\.name) == core.series.map(\.name), "\(item.text)")
                #expect(mine.series.map(\.values) == core.series.map(\.values), "\(item.text)")
            case (.no(let mine), .no(let core)): #expect(mine == core, "\(item.text)")
            case (let mine, let core): Issue.record("\(item.text): \(mine) where core says \(core)")
            }
        }
    }

    @Test func figuresAreReadAsCoreReadsThem() {
        for item in blocks.stats {
            switch (Blocks.stats(item.text), item.read) {
            case (.ok(let mine), .ok(let core)):
                #expect(mine.count == core.count, "\(item.text)")
                for (stat, expected) in zip(mine, core) {
                    #expect(stat.label == expected.label && stat.unit == expected.unit && stat.delta == expected.delta && stat.note == expected.note && stat.good == expected.good)
                    switch (stat.value, expected.value) {
                    case (.number(let n), .number(let m)): #expect(n == m)
                    case (.text(let a), .string(let b)): #expect(a == b)
                    default: Issue.record("\(stat.label): \(stat.value) where core has \(expected.value)")
                    }
                }
            case (.no(let mine), .no(let core)): #expect(mine == core, "\(item.text)")
            case (let mine, let core): Issue.record("\(item.text): \(mine) where core says \(core)")
            }
        }
    }

    @Test func choicesAndStepsAreReadAsCoreReadsThem() {
        for item in blocks.choices {
            switch (Blocks.choices(item.text), item.read) {
            case (.ok(let mine), .ok(let core)): #expect(mine == core, "\(item.text)")
            case (.no(let mine), .no(let core)): #expect(mine == core, "\(item.text)")
            case (let mine, let core): Issue.record("\(item.text): \(mine) where core says \(core)")
            }
        }
        for item in blocks.steps {
            switch (Blocks.steps(item.text), item.read) {
            case (.ok(let mine), .ok(let core)): #expect(mine.map { [$0.text, $0.state.rawValue] } == core.map { [$0.text, $0.state] }, "\(item.text)")
            case (.no(let mine), .no(let core)): #expect(mine == core, "\(item.text)")
            case (let mine, let core): Issue.record("\(item.text): \(mine) where core says \(core)")
            }
        }
    }

    @Test func pagesAndTheirTitlesAreReadAsCoreReadsThem() {
        for item in blocks.artifacts {
            switch Blocks.artifact(item.page) {
            case .ok(let page):
                #expect(item.ok)
                #expect(Blocks.artifactTitle(page) == item.title)
            case .no(let why): #expect(why == item.why)
            }
        }
    }

    @Test func numbersAreWrittenAsCoreWritesThem() {
        for item in blocks.numbers { #expect(Blocks.compactNumber(item.n) == item.text, "\(item.n)") }
        #expect(Blocks.withUnit("12", "%") == "12%")
        #expect(Blocks.withUnit("3,400", "DKK") == "3,400 DKK")
    }

    @Test func aSealedPageLoadsNothingAndRunsNothingUntilYouSaySo() {
        let shown = PageFrame.framed(#"<link rel="stylesheet" href="https://x.example/a.css"><p>Hi</p>"#, run: false)
        #expect(shown.hasPrefix("<!doctype html><meta charset=\"utf-8\"><meta http-equiv=\"Content-Security-Policy\" content=\"default-src 'none';"))
        #expect(!shown.contains("script-src"))
        #expect(!shown.contains("<link"))
        #expect(PageFrame.framed("<p>Hi</p>", run: true).contains("; script-src 'unsafe-inline'\""))
    }
}
