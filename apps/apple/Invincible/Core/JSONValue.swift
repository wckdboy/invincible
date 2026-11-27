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

/// Sent back as it came: a loop it drafted (its task and what wakes it) is added as it was drafted.
extension JSONValue: Encodable {
    func encode(to encoder: any Encoder) throws {
        var container = encoder.singleValueContainer()
        switch self {
        case .null: try container.encodeNil()
        case .bool(let bool): try container.encode(bool)
        case .number(let number): try container.encode(number)
        case .string(let string): try container.encode(string)
        case .array(let array): try container.encode(array)
        case .object(let object): try container.encode(object)
        }
    }
}

extension JSONValue {
    /// An object's member by its name (nil: none, or not an object).
    subscript(_ key: String) -> JSONValue? { if case .object(let object) = self { object[key] } else { nil } }
    var string: String? { if case .string(let string) = self { string } else { nil } }
    var bool: Bool? { if case .bool(let bool) = self { bool } else { nil } }
    var array: [JSONValue]? { if case .array(let array) = self { array } else { nil } }
    var object: [String: JSONValue]? { if case .object(let object) = self { object } else { nil } }
}
