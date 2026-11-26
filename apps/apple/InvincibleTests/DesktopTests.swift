import CoreGraphics
import Foundation
import Testing
@testable import Invincible

/// An agent's desktop as the PWA reads it (`lib/desktop.ts`): where a tap lands, what is an address, which pictures are shown.
struct DesktopTests {
    let cases = Vectors.shared.desktop

    @Test func aTapLandsWhereThePWASaysOnTheAgentsScreen() {
        for item in cases.points {
            let point = Desktop.point(tap: CGPoint(x: item.tap.x, y: item.tap.y), shown: CGRect(x: item.shown.left, y: item.shown.top, width: item.shown.width, height: item.shown.height), screen: (item.screen.width, item.screen.height))
            #expect(point.map { Vectors.DesktopCases.XY(x: Double($0.x), y: Double($0.y)) } == item.point, "\(item.tap)")
        }
        #expect(Desktop.point(tap: CGPoint(x: 1, y: 1), shown: .zero, screen: (1280, 800)) == nil && cases.unshown == nil)
    }

    @Test func anAddressIsTakenAsThePWATakesIt() {
        for item in cases.addresses {
            #expect(Desktop.address(item.text) == item.address, "\(item.text.prefix(40))")
        }
    }

    @Test func onlyAScreensJPEGOrPNGIsShown() {
        for item in cases.shots {
            #expect((Desktop.picture(item.view) != nil) == item.shown, "\(item.view.shot.mediaType) \(item.view.shot.data)")
        }
    }

    @Test func whatIsDoneIsSentAsTheNodeTakesIt() throws {
        let sent = { (action: DesktopAction) in String(decoding: try JSONEncoder().encode(action), as: UTF8.self) }
        let json = { (text: String) in try JSONSerialization.jsonObject(with: Data(text.utf8)) as? NSDictionary }
        #expect(try json(sent(.click(x: 10, y: 20))) == ["do": "click", "x": 10, "y": 20])
        #expect(try json(sent(.scroll(up: false, times: 3))) == ["do": "scroll", "direction": "down", "times": 3])
        #expect(try json(sent(.type("hello"))) == ["do": "type", "text": "hello"])
        #expect(try json(sent(.key("Return"))) == ["do": "key", "keys": ["Return"]])
        #expect(try json(sent(.open("https://invincible.sh"))) == ["do": "open", "address": "https://invincible.sh"])
    }

    @Test func theNodesRefusalOfADesktoplessVMIsToldApart() {
        #expect(Desktop.saysNoDesktop(NodeError(status: 424, message: "this agent's VM has no desktop: make it again with one")))
        #expect(!Desktop.saysNoDesktop(NodeError(status: 424, message: "this agent has no VM yet")))
        #expect(!Desktop.saysNoDesktop(NodeError(status: 500, message: "no desktop")))
    }
}
