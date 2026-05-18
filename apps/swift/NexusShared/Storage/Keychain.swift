// Keychain — thin wrapper over SecItemAdd / SecItemCopyMatching for storing
// the user-supplied ElevenLabs API key on the local Mac.
//
// Spec: openspec/changes/swift-owns-elevenlabs-synth (task 1.1)
//
// Why this exists: the agent used to hold the key encrypted at rest in the
// elevenlabs_credentials table, decrypting on every TTS call. That coupled
// the Mac listener to the agent's network availability and the
// NEXUS_ENCRYPTION_KEY rotation cadence. Moving the key into Keychain on
// the Mac side removes both dependencies — the listener can synth even
// when the agent is unreachable and the agent never sees the secret.

import Foundation
import Security

public enum KeychainError: Error {
    case unhandled(OSStatus)
    case notFound
    case malformed
}

public enum Keychain {
    /// Service identifier used for every nexus-mac Keychain item. Constants
    /// avoid typos that would silently create orphan items.
    public static let service = "dev.nexus.mac"

    public static func set(_ value: String, for account: String) throws {
        guard let data = value.data(using: .utf8) else { throw KeychainError.malformed }

        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
        ]

        let attributes: [String: Any] = [
            kSecValueData as String: data,
        ]

        let updateStatus = SecItemUpdate(query as CFDictionary, attributes as CFDictionary)
        if updateStatus == errSecSuccess { return }
        if updateStatus != errSecItemNotFound {
            throw KeychainError.unhandled(updateStatus)
        }

        var addQuery = query
        addQuery[kSecValueData as String] = data
        let addStatus = SecItemAdd(addQuery as CFDictionary, nil)
        guard addStatus == errSecSuccess else {
            throw KeychainError.unhandled(addStatus)
        }
    }

    public static func get(_ account: String) throws -> String {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
            kSecReturnData as String: true,
            kSecMatchLimit as String: kSecMatchLimitOne,
        ]
        var result: AnyObject?
        let status = SecItemCopyMatching(query as CFDictionary, &result)
        guard status != errSecItemNotFound else { throw KeychainError.notFound }
        guard status == errSecSuccess else { throw KeychainError.unhandled(status) }
        guard let data = result as? Data, let value = String(data: data, encoding: .utf8) else {
            throw KeychainError.malformed
        }
        return value
    }

    public static func delete(_ account: String) throws {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
        ]
        let status = SecItemDelete(query as CFDictionary)
        if status != errSecSuccess && status != errSecItemNotFound {
            throw KeychainError.unhandled(status)
        }
    }
}

/// Canonical account names for nexus-mac Keychain items.
public enum KeychainAccount {
    public static let elevenLabsApiKey = "elevenlabs.api_key"
    public static let elevenLabsVoiceId = "elevenlabs.voice_id"
}
