import Foundation
import LocalAuthentication
import Security

/**
 * Keys you chose to keep on this iPhone as well as on your nodes: in its Keychain, for this device alone (never in a
 * backup, never synced), each read back only with Face ID or the passcode where the iPhone has one. A copy is kept so a
 * key can be sealed again (to a node that lost it, or a fleet founded anew) without fetching it from its provider again.
 * Its name, what it's for and its label can be listed without unlocking it; its value never is.
 */
enum PhoneKeys {
    /// What is said of a kept copy without unlocking it.
    struct Kept: Codable, Sendable, Identifiable, Equatable {
        let name: String
        var provider: String?
        var label: String?
        let keptAt: Date
        var id: String { name }
    }

    enum Failure: Error, LocalizedError, Equatable {
        case keychain(OSStatus)
        case notFound

        var errorDescription: String? {
            switch self {
            case .keychain(let status): "The Keychain refused (\(status): \(SecCopyErrorMessageString(status, nil) as String? ?? "no reason given"))."
            case .notFound: "This iPhone keeps no copy of that key."
            }
        }
    }

    static let service = "sh.invincible.bot.keys"

    /// Whether this device keeps copies at all. An iPhone or an iPad does. A Mac's app does once it is signed with a
    /// profile, which opens to it the Keychain that asks for Touch ID before it gives one back (M2, docs/MAC.md): signed to
    /// run on this Mac alone, it has only the login keychain, which can't.
    #if os(iOS)
    static let offered = true
    #else
    static let offered = false
    #endif

    /// Keeps a copy, replacing one kept under the same name. `service`: tests keep theirs apart.
    static func keep(name: String, value: String, provider: String?, label: String?, service: String = service) throws {
        try? forget(name: name, service: service)
        let kept = Kept(name: name, provider: provider, label: label, keptAt: .now)
        var item: [CFString: Any] = [
            kSecClass: kSecClassGenericPassword,
            kSecAttrService: service,
            kSecAttrAccount: name,
            kSecAttrSynchronizable: false,
            kSecAttrGeneric: try JSONEncoder().encode(kept),
            kSecValueData: Data(value.utf8),
        ]
        // Read back only by its owner, where the iPhone can ask: Face ID, Touch ID or the passcode. One without a passcode
        // can't ask, and keeps it for this device alone, readable while it is unlocked.
        var error: Unmanaged<CFError>?
        if LAContext().canEvaluatePolicy(.deviceOwnerAuthentication, error: nil),
           let access = SecAccessControlCreateWithFlags(nil, kSecAttrAccessibleWhenPasscodeSetThisDeviceOnly, .userPresence, &error) {
            item[kSecAttrAccessControl] = access
        } else {
            item[kSecAttrAccessible] = kSecAttrAccessibleWhenUnlockedThisDeviceOnly
        }
        let status = SecItemAdd(item as CFDictionary, nil)
        guard status == errSecSuccess else { throw Failure.keychain(status) }
    }

    /// Every copy this iPhone keeps, by name; nothing is unlocked to say so.
    static func list(service: String = service) -> [Kept] {
        let context = LAContext()
        context.interactionNotAllowed = true
        let query: [CFString: Any] = [
            kSecClass: kSecClassGenericPassword,
            kSecAttrService: service,
            kSecReturnAttributes: true,
            kSecMatchLimit: kSecMatchLimitAll,
            kSecUseAuthenticationContext: context,
        ]
        var found: CFTypeRef?
        guard SecItemCopyMatching(query as CFDictionary, &found) == errSecSuccess, let items = found as? [[CFString: Any]] else { return [] }
        return items.compactMap { item in
            (item[kSecAttrGeneric] as? Data).flatMap { try? JSONDecoder().decode(Kept.self, from: $0) }
        }.sorted { $0.name < $1.name }
    }

    /// A copy's value, once you have shown it is you (`reason` says why you're asked).
    static func value(of name: String, reason: String, service: String = service) async throws -> String {
        let context = LAContext()
        context.localizedReason = reason
        return try await Task.detached {
            let query: [CFString: Any] = [
                kSecClass: kSecClassGenericPassword,
                kSecAttrService: service,
                kSecAttrAccount: name,
                kSecReturnData: true,
                kSecUseAuthenticationContext: context,
            ]
            var found: CFTypeRef?
            let status = SecItemCopyMatching(query as CFDictionary, &found)
            if status == errSecItemNotFound { throw Failure.notFound }
            guard status == errSecSuccess, let data = found as? Data else { throw Failure.keychain(status) }
            return String(decoding: data, as: UTF8.self)
        }.value
    }

    /// Deletes this iPhone's copy (the key sealed on your nodes stays as it is).
    static func forget(name: String, service: String = service) throws {
        let status = SecItemDelete([kSecClass: kSecClassGenericPassword, kSecAttrService: service, kSecAttrAccount: name] as CFDictionary)
        guard status == errSecSuccess || status == errSecItemNotFound else { throw Failure.keychain(status) }
    }
}
