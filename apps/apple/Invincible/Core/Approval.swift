import Foundation

/// An approval as the PWA's Inbox says it (apps/web/src/views/inbox.ts, lib/orders.ts, views/activity.ts).
enum Approval {
    /// Who asked, as you'd say it: "loop:morning" is "the loop morning".
    static func askedBy(_ by: String) -> String {
        let parts = by.split(separator: ":", maxSplits: 1, omittingEmptySubsequences: false)
        let words = ["loop": "the loop", "arm": "the arm", "node": "the node", "run": "the run"]
        guard parts.count == 2, let kind = words[String(parts[0])], !parts[1].isEmpty else { return by }
        return "\(kind) \(parts[1])"
    }

    /// What a delete names, for typing before you approve it: the last segment of where it goes ("DELETE /…/buckets/
    /// scratch" is "scratch"); for an MCP tool, its one argument; otherwise the tool's name.
    static func deleteName(connector: String, tool: String, target: String, args: [String: JSONValue]) -> String {
        let fallback = "\(connector).\(tool)"
        if target.prefixMatch(of: #/mcp\s/#) != nil {
            let scalars = args.values.compactMap(scalarText)
            return scalars.count == 1 ? scalars[0] : fallback
        }
        let path = target.replacing(#/^[A-Z]+\s+/#, with: "").split(whereSeparator: { $0 == "?" || $0 == "#" }).first.map(String.init) ?? ""
        guard let last = path.split(separator: "/").last.map(String.init) else { return fallback }
        return last.removingPercentEncoding ?? last
    }

    /// The kept work an approval would send (a ship's, or a fix's push): its artifact, to read before you answer (the
    /// PWA's keptWork); nil when it sends none.
    static func work(_ args: [String: JSONValue]) -> String? {
        guard case .string(let id) = args["artifact"], id.wholeMatch(of: #/art_[A-Za-z0-9_-]{22}/#) != nil else { return nil }
        return id
    }

    /// A string, number or truth as its text (a number as JavaScript writes it); nil for anything else.
    private static func scalarText(_ value: JSONValue) -> String? {
        switch value {
        case .string(let text): text
        case .number(let number): number.rounded() == number && abs(number) < 1e15 ? String(Int(number)) : String(number)
        case .bool(let truth): truth ? "true" : "false"
        default: nil
        }
    }

    /// What a class of call does (the policy's classes), in a line.
    static func classLine(_ kind: String) -> String {
        switch kind {
        case "read": "Read: look, list, fetch"
        case "create": "Create: a new bucket, branch, container or credential"
        case "modify": "Modify: change config, write objects, edit files"
        case "outward": "Outward: push, send, post, deploy, purchase"
        case "delete": "Delete: remove something persistent"
        default: kind
        }
    }

    static func symbol(_ kind: String) -> String {
        switch kind {
        case "outward": "paperplane.fill"
        case "delete": "trash.fill"
        case "create": "plus.circle.fill"
        case "modify": "pencil.circle.fill"
        default: "eye.fill"
        }
    }
}
