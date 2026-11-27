import Foundation
import SwiftUI
import Testing
import UIKit
@testable import Invincible

/// A node that proves to be another (NodePin) is said on the chat, where the app opens, with Try again and Forget this
/// device (the lead's word of 27 November 2026: Android found the refusal said only on the old Home and Agents once its app
/// opened on the chat). Against a node on this machine's loopback (LocalNode, SessionProofTests). Its picture, the chat as
/// an iPhone shows it refused, in light and dark, is kept with the run (chat-refused-light.png, chat-refused-dark.png).
@MainActor @Suite(.serialized) struct ChatRefusalTests {
    @Test func aNodeThatProvesToBeAnotherIsSaidOnTheChatWithTryAgainAndForget() async throws {
        let node = try await LocalNode(.b)
        defer { node.stop() }
        let tag = "sh.invincible.bot.tests.chat-refused"
        defer { try? DeviceKey.delete(tag: tag) }
        let key = try DeviceKey.create(tag: tag)
        let session = Session(key: key, node: PairedNode(origin: node.origin, device: key.device, name: "tests", fleet: "f_tests", nodeId: node.a))
        await session.refresh()
        let refused = try #require(ChatView.refusal(session.trouble), "a node that proves to be another wasn't said on the chat")
        #expect(refused.notYourNode == node.b)
        #expect(ChatView.refusal(nil) == nil)
        for style in [UIUserInterfaceStyle.light, .dark] {
            let png = try await Self.picture(session, style)
            #expect(png.count > 10_000, "the chat drew nothing")
            Attachment.record(png, named: "chat-refused-\(style == .dark ? "dark" : "light").png")
        }
    }

    /// The chat as an iPhone shows it, in a window of the test's own, drawn as the screen draws it: its bar, its card, its box.
    private static func picture(_ session: Session, _ style: UIUserInterfaceStyle) async throws -> Data {
        let scene = try #require(UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first)
        let window = UIWindow(windowScene: scene)
        window.frame = CGRect(x: 0, y: 0, width: 402, height: 874)
        window.overrideUserInterfaceStyle = style
        window.rootViewController = UIHostingController(rootView: NavigationStack { ChatView(session: session, roster: {}, forget: {}) }.tint(Color.ink))
        window.makeKeyAndVisible()
        defer { window.isHidden = true }
        try await Task.sleep(for: .seconds(2))
        let image = UIGraphicsImageRenderer(bounds: window.bounds).image { _ in _ = window.drawHierarchy(in: window.bounds, afterScreenUpdates: true) }
        return try #require(image.pngData())
    }
}
