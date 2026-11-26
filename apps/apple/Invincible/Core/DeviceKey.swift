import CryptoKit
import Foundation
import Security

/**
 * This device's identity: an ECDSA P-256 key that can sign but can never be read out, not even by this app. It is made
 * inside the Secure Enclave wherever there is one: every iPhone and iPad that runs iOS 26, and a simulator that emulates
 * one (Xcode's does on Apple silicon). Only where there is none is it a software key in the Keychain, and that one is
 * weaker: iOS hands a software key's bytes back to the app that made it, whatever kSecAttrIsExtractable says (measured:
 * DeviceKeyTests). Either way it is kept for this device only (never in a backup or iCloud Keychain), and the app holds
 * a reference to it, never its bytes. Its public key is the device id (`DeviceID`).
 *
 * Every Mac that runs macOS 27 has a Secure Enclave too, and the Mac's key is made in it, but held otherwise: the Keychain
 * an iPhone keeps enclave keys in opens on a Mac only to an app signed with a profile, which a build signed to run on this
 * Mac isn't (measured: it refuses, -34018). So on the Mac the enclave key is CryptoKit's, and the enclave hands it back
 * wrapped for itself alone: that wrapping is what the login keychain keeps, for this app, under the same tag. It is no
 * key (measured: DeviceKeyTests), and no other Mac's enclave can open it.
 */
final class DeviceKey: RequestSigner, @unchecked Sendable {
    // (Unchecked: a SecKey is an immutable reference the Security framework lets any thread use; CryptoKit's enclave key is
    // an immutable value.)

    enum Storage: Sendable { case secureEnclave, keychain }

    struct Failure: LocalizedError {
        let errorDescription: String?
        init(_ what: String) { errorDescription = what }
        init(_ what: String, status: OSStatus) {
            errorDescription = "\(what) (\(SecCopyErrorMessageString(status, nil) as String? ?? "status \(status)"))"
        }
        init(_ what: String, error: Unmanaged<CFError>?) {
            errorDescription = "\(what) (\(error.map { $0.takeRetainedValue().localizedDescription } ?? "no reason given"))"
        }
    }

    /// The app's own key; tests use tags of their own.
    static let appTag = "sh.invincible.bot.device-key"

    /// Where a new key is made: the Secure Enclave wherever there is one.
    static var preferred: Storage { SecureEnclave.isAvailable ? .secureEnclave : .keychain }

    let device: String
    /// Uncompressed: 0x04, x, y (65 bytes).
    let publicKey: Data
    let storage: Storage
    private let privateKey: Held

    /// The key itself, as it is held: the Keychain's reference to it, or on the Mac an enclave key as CryptoKit holds it.
    private enum Held {
        case reference(SecKey)
        #if os(macOS)
        case enclave(SecureEnclave.P256.Signing.PrivateKey)
        #endif
    }

    private init(privateKey: SecKey) throws {
        var error: Unmanaged<CFError>?
        guard let publicKey = SecKeyCopyPublicKey(privateKey), let raw = SecKeyCopyExternalRepresentation(publicKey, &error) as Data? else {
            throw Failure("This device's key has no public key", error: error)
        }
        let attributes = SecKeyCopyAttributes(privateKey) as? [CFString: Any]
        self.privateKey = .reference(privateKey)
        self.publicKey = raw
        self.device = DeviceID.client(publicKey: raw)
        self.storage = (attributes?[kSecAttrTokenID] as? String) == (kSecAttrTokenIDSecureEnclave as String) ? .secureEnclave : .keychain
    }

    /// This device's key, or nil when none was ever made. A Keychain that can't be read is an error, never "no key"
    /// (which would invite pairing over it).
    static func load(tag: String = appTag) throws -> DeviceKey? {
        #if os(macOS)
        if let wrapped = try wrapped(tag: tag) { return try DeviceKey(wrapped: wrapped) }
        #endif
        return try reference(tag: tag).map(DeviceKey.init(privateKey:))
    }

    /// A new key, kept under `tag`.
    static func create(tag: String = appTag, in storage: Storage = preferred) throws -> DeviceKey {
        #if os(macOS)
        if storage == .secureEnclave { return try createInEnclave(tag: tag) }
        #endif
        var error: Unmanaged<CFError>?
        var key: [CFString: Any] = [kSecAttrIsPermanent: true, kSecAttrApplicationTag: Data(tag.utf8)]
        var attributes: [CFString: Any] = [kSecAttrKeyType: kSecAttrKeyTypeECSECPrimeRandom, kSecAttrKeySizeInBits: 256]
        if storage == .secureEnclave {
            guard let access = SecAccessControlCreateWithFlags(nil, kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly, .privateKeyUsage, &error) else {
                throw Failure("Couldn't describe the key's access", error: error)
            }
            key[kSecAttrAccessControl] = access
            attributes[kSecAttrTokenID] = kSecAttrTokenIDSecureEnclave
        } else {
            key[kSecAttrAccessible] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        }
        attributes[kSecPrivateKeyAttrs] = key
        guard let privateKey = SecKeyCreateRandomKey(attributes as CFDictionary, &error) else {
            throw Failure("Couldn't make this device's key", error: error)
        }
        return try DeviceKey(privateKey: privateKey)
    }

    /// Forgets the key. It can't be recovered: pairing again makes a new one, a new device to the fleet.
    static func delete(tag: String = appTag) throws {
        let status = SecItemDelete(query(tag: tag) as CFDictionary)
        guard status == errSecSuccess || status == errSecItemNotFound else { throw Failure("Couldn't forget this device's key", status: status) }
        #if os(macOS)
        let wrapped = SecItemDelete(wrappedQuery(tag: tag) as CFDictionary)
        guard wrapped == errSecSuccess || wrapped == errSecItemNotFound else { throw Failure("Couldn't forget this device's key", status: wrapped) }
        #endif
    }

    /// The Keychain's reference to the private key under `tag`, or nil when there is none.
    static func reference(tag: String) throws -> SecKey? {
        var item: CFTypeRef?
        var lookup = query(tag: tag)
        lookup[kSecReturnRef] = true
        let status = SecItemCopyMatching(lookup as CFDictionary, &item)
        if status == errSecItemNotFound { return nil }
        guard status == errSecSuccess, let item, CFGetTypeID(item) == SecKeyGetTypeID() else {
            throw Failure("Couldn't read this device's key", status: status)
        }
        return (item as! SecKey)
    }

    private static func query(tag: String) -> [CFString: Any] {
        [kSecClass: kSecClassKey, kSecAttrApplicationTag: Data(tag.utf8), kSecAttrKeyType: kSecAttrKeyTypeECSECPrimeRandom, kSecAttrKeyClass: kSecAttrKeyClassPrivate]
    }

    func sign(_ message: Data) throws -> Data {
        switch privateKey {
        case .reference(let privateKey):
            var error: Unmanaged<CFError>?
            guard let der = SecKeyCreateSignature(privateKey, .ecdsaSignatureMessageX962SHA256, message as CFData, &error) as Data? else {
                throw Failure("This device's key couldn't sign", error: error)
            }
            return try RequestAuth.rawSignature(fromDER: der)
        #if os(macOS)
        case .enclave(let key):
            do {
                return try key.signature(for: message).rawRepresentation
            } catch {
                throw Failure("This device's key couldn't sign (\(error.localizedDescription))")
            }
        #endif
        }
    }

    #if os(macOS)
    private init(enclave key: SecureEnclave.P256.Signing.PrivateKey) {
        let raw = key.publicKey.x963Representation
        privateKey = .enclave(key)
        publicKey = raw
        device = DeviceID.client(publicKey: raw)
        storage = .secureEnclave
    }

    private convenience init(wrapped: Data) throws {
        do {
            self.init(enclave: try SecureEnclave.P256.Signing.PrivateKey(dataRepresentation: wrapped))
        } catch {
            throw Failure("This Mac's Secure Enclave can't open this device's key (\(error.localizedDescription)). A key made on another Mac opens on no other: forget this device and pair this Mac again.")
        }
    }

    /// A new key in this Mac's enclave, its wrapping kept in the login keychain under `tag`.
    private static func createInEnclave(tag: String) throws -> DeviceKey {
        var error: Unmanaged<CFError>?
        guard let access = SecAccessControlCreateWithFlags(nil, kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly, .privateKeyUsage, &error) else {
            throw Failure("Couldn't describe the key's access", error: error)
        }
        let key: SecureEnclave.P256.Signing.PrivateKey
        do {
            key = try SecureEnclave.P256.Signing.PrivateKey(accessControl: access)
        } catch {
            throw Failure("Couldn't make this device's key (\(error.localizedDescription))")
        }
        var item = wrappedQuery(tag: tag)
        item[kSecValueData] = key.dataRepresentation
        item[kSecAttrAccessible] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        item[kSecAttrLabel] = "Invincible: this Mac's key, wrapped by its Secure Enclave"
        let status = SecItemAdd(item as CFDictionary, nil)
        guard status == errSecSuccess else { throw Failure("Couldn't keep this device's key", status: status) }
        return DeviceKey(enclave: key)
    }

    /// What the login keychain keeps of an enclave key under `tag`: the enclave's wrapping of it, or nil when there is none.
    static func wrapped(tag: String) throws -> Data? {
        var item: CFTypeRef?
        var lookup = wrappedQuery(tag: tag)
        lookup[kSecReturnData] = true
        let status = SecItemCopyMatching(lookup as CFDictionary, &item)
        if status == errSecItemNotFound { return nil }
        guard status == errSecSuccess, let wrapped = item as? Data else { throw Failure("Couldn't read this device's key", status: status) }
        return wrapped
    }

    private static func wrappedQuery(tag: String) -> [CFString: Any] {
        [kSecClass: kSecClassGenericPassword, kSecAttrService: tag, kSecAttrAccount: "secure-enclave"]
    }
    #endif
}
