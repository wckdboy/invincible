import Foundation

/// Any JSON value: for what the app shows as it came (an approval's arguments) or checks field by field (an agent's
/// saved look), never trusting its shape.
enum JSONValue: Decodable, Equatable, Sendable {
    case null
    case bool(Bool)
    case number(Double)
    case string(String)
    case array([JSONValue])
    case object([String: JSONValue])

    init(from decoder: any Decoder) throws {
        let container = try decoder.singleValueContainer()
        if container.decodeNil() {
            self = .null
        } else if let bool = try? container.decode(Bool.self) {
            self = .bool(bool)
        } else if let number = try? container.decode(Double.self) {
            self = .number(number)
        } else if let string = try? container.decode(String.self) {
            self = .string(string)
        } else if let array = try? container.decode([JSONValue].self) {
            self = .array(array)
        } else {
            self = .object(try container.decode([String: JSONValue].self))
        }
    }

    /// A string as it is; anything else as compact JSON, to be read.
    var text: String {
        switch self {
        case .string(let string): string
        default: (try? JSONSerialization.data(withJSONObject: any, options: [.fragmentsAllowed, .sortedKeys, .withoutEscapingSlashes])).map { String(decoding: $0, as: UTF8.self) } ?? ""
        }
    }

    private var any: Any {
        switch self {
        case .null: NSNull()
        case .bool(let bool): bool
        case .number(let number): number.rounded() == number && abs(number) < 1e15 ? Int(number) as Any : number
        case .string(let string): string
        case .array(let array): array.map(\.any)
        case .object(let object): object.mapValues(\.any)
        }
    }
}
