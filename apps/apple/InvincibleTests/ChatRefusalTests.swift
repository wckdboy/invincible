#if os(iOS)
import Foundation
import SwiftUI
import Testing
import UIKit
@testable import Invincible

/// A node that proves to be another (NodePin) is said on Home, where the app opens (since 28 November 2026), with Try
/// again, and on the chat with Try again and Forget this device (the lead's word of 27 November 2026: Android found the
/// refusal said only on some of its screens). Against a node on this machine's loopback (LocalNode, SessionProofTests). Its
/// pictures, Home and the chat as an iPhone shows them refused, in light and dark, are kept with the run
/// (home-refused-light.png, chat-refused-light.png and their dark ones).
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
            let look = style == .dark ? "dark" : "light"
            let home = try await Self.picture(AnyView(HomeList(session: session, saysLink: true, open: { _ in }, settings: {}, newChat: {})), style)
            #expect(home.count > 10_000, "Home drew nothing")
            Attachment.record(home, named: "home-refused-\(look).png")
            let png = try await Self.picture(AnyView(ChatView(session: session, forget: {})), style)
            #expect(png.count > 10_000, "the chat drew nothing")
            Attachment.record(png, named: "chat-refused-\(look).png")
        }
    }

    /// A screen as an iPhone shows it, in a window of the test's own, drawn as the screen draws it: its bar, its card, its box.
    private static func picture(_ screen: AnyView, _ style: UIUserInterfaceStyle) async throws -> Data {
        let scene = try #require(UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first)
        let window = UIWindow(windowScene: scene)
        window.frame = CGRect(x: 0, y: 0, width: 402, height: 874)
        window.overrideUserInterfaceStyle = style
        window.rootViewController = UIHostingController(rootView: NavigationStack { screen }.tint(Color.ink))
        window.makeKeyAndVisible()
        defer { window.isHidden = true }
        try await Task.sleep(for: .seconds(2))
        let image = UIGraphicsImageRenderer(bounds: window.bounds).image { _ in _ = window.drawHierarchy(in: window.bounds, afterScreenUpdates: true) }
        return try #require(image.pngData())
    }
}
#endif
