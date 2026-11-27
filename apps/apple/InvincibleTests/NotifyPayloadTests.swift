import Foundation
import Testing
@testable import Invincible

/// A notification's payload as the Mac app collects it, read as strictly as core reads it (the vectors' `notifyPayload`),
/// and shown with what the iPhone is sent for it (apns-send.ts applePayload): its buttons, its thread, its sound, and ours
/// in its userInfo, which Push reads as it reads a pushed one.
struct NotifyPayloadTests {
    @Test func eachPayloadIsReadOrRefusedAsCoreReadsIt() {
        let cases = Vectors.shared.notifyPayload
        #expect(NotifyPayload.titleMax == cases.titleMax && NotifyPayload.bodyMax == cases.bodyMax)
        for item in cases.read {
            let read = NotifyPayload.read(item.raw)
            if let want = item.read, want != .null {
                #expect(read == payload(want), "\(String(describing: item.raw))")
            } else {
                #expect(read == nil, "core refuses \(String(describing: item.raw))")
            }
        }
    }

    @Test func theGeneralOneIsCores() {
        #expect(NotifyPayload.generic == payload(Vectors.shared.notifyPayload.generic))
    }

    @Test func itsTextIsCleanedAsCoreCleansIt() {
        for item in Vectors.shared.notifyPayload.clean {
            let clean = NotifyPayload.clean(item.text, max: item.max)
            #expect(clean.utf16.elementsEqual(item.clean.utf16), "\(item.text.debugDescription) → \(clean.debugDescription)")
        }
    }

    @Test func itIsShownWithWhatTheIPhoneIsSentForIt() throws {
        var shown = 0
        for item in Vectors.shared.notifyPayload.read {
            guard let apple = item.apple, apple != .null, let read = NotifyPayload.read(item.raw) else { continue }
            shown += 1
            let aps = apple["aps"]
            #expect(read.category == aps?["category"]?.string, "\(read.kind) \(String(describing: read.action))")
            #expect(read.quiet == (aps?["interruption-level"]?.string == "passive"), "\(read.kind)")
            #expect(read.quiet == (aps?["sound"] == nil), "\(read.kind)")
            #expect(aps?["thread-id"]?.string == read.kind)
            // Ours, as the iPhone's carries it, read by Push as a pushed one is.
            let ours = try JSONDecoder().decode(JSONValue.self, from: JSONSerialization.data(withJSONObject: read.userInfo["invincible"] as Any))
            #expect(ours == apple["invincible"], "\(ours.text) ≠ \(apple["invincible"]?.text ?? "none")")
            #expect(Push.tag(read.userInfo) == read.tag)
            #expect(Push.kind(read.userInfo) == read.kind)
            #expect(Push.action(read.userInfo) == read.action)
            #expect(Push.shipTask(read.userInfo) == (read.ship ? read.task : nil))
            #expect(Push.destination(read.userInfo) == destination(read))
        }
        #expect(shown >= 15)
    }
}

/// How a Mac shows what it collected (NotifyPayload.content), and how any of the app's notifications shows while it is open
/// (NoticeAnswers.options): as the iPhone is sent it, and quiet about what the screen shows.
struct NoticeShownTests {
    @Test func aCollectedOneIsShownAsTheIPhoneIsSentIt() {
        var shown = 0
        for item in Vectors.shared.notifyPayload.read {
            guard let apple = item.apple, apple != .null, let read = NotifyPayload.read(item.raw) else { continue }
            shown += 1
            let aps = apple["aps"]
            let content = read.content
            #expect(content.title == aps?["alert"]?["title"]?.string)
            #expect(content.body == aps?["alert"]?["body"]?.string)
            #expect(content.threadIdentifier == aps?["thread-id"]?.string)
            #expect(content.categoryIdentifier == (aps?["category"]?.string ?? ""))
            #expect((content.sound != nil) == (aps?["sound"] != nil), "\(read.kind)")
            #expect(content.interruptionLevel == (aps?["interruption-level"]?.string == "passive" ? .passive : .active), "\(read.kind)")
            #expect(Push.tag(content.userInfo) == read.tag)
            #expect(read.request.identifier == read.tag)
        }
        #expect(shown >= 15)
    }

    @Test func whileTheAppIsOpenItIsQuietAboutWhatTheScreenShows() {
        let task = NotifyPayload.read(.object(["v": .number(1), "kind": .string("finished"), "title": .string("Your agent's task: Proven"), "body": .string("Proven."), "open": .string("task"), "task": .string("task-abc123def456"), "tag": .string("t-1")]))!
        let ask = NotifyPayload.read(.object(["v": .number(1), "kind": .string("approval"), "title": .string("Your agent asks your approval"), "body": .string("An action waits."), "open": .string("inbox"), "tag": .string("t-2")]))!
        // About what shows: only in the list.
        #expect(NoticeAnswers.options(task.userInfo, showing: .task("task-abc123def456")) == [.list])
        #expect(NoticeAnswers.options(ask.userInfo, showing: .inbox) == [.list])
        // About something else: a banner, and a sound unless it's news.
        #expect(NoticeAnswers.options(task.userInfo, showing: .task("task-zzz999zzz999")) == [.list, .banner])
        #expect(NoticeAnswers.options(ask.userInfo, showing: nil) == [.list, .banner, .sound])
    }

    @Test func aPlaceShowsWhatANotificationWouldName() {
        #expect(Place.task("task-abc123def456").shown(chat: nil) == .task("task-abc123def456"))
        #expect(Place.agent("coder").shown(chat: nil) == .agent("coder"))
        #expect(Place.primary.shown(chat: "cv_1") == .chat("cv_1"))
        #expect(Place.inbox.shown(chat: nil) == .inbox)
        for place in [Place.home, .agents, .more, .thisMac, .chats, .keys, .connectors, .room("forge")] { #expect(place.shown(chat: "cv_1") == nil) }
    }
}

/// A payload as the vectors hold core's reading of it.
private func payload(_ v: JSONValue) -> NotifyPayload? {
    guard let kind = v["kind"]?.string, let title = v["title"]?.string, let body = v["body"]?.string, let open = v["open"]?.string, let tag = v["tag"]?.string else { return nil }
    return NotifyPayload(
        kind: kind, title: title, body: body, open: open, conversation: v["conversation"]?.string, task: v["task"]?.string,
        ship: v["ship"]?.bool == true, tag: tag, action: v["action"]?.string, approvable: v["approvable"]?.bool == true)
}

/// Where a tap on it opens, as Push says for a pushed one.
private func destination(_ p: NotifyPayload) -> Push.Destination {
    switch p.open {
    case "chat": .chat(p.conversation)
    case "overview": .overview
    case "settings": .settings
    case "task": p.task.map { .task($0) } ?? .overview
    default: .inbox
    }
}
