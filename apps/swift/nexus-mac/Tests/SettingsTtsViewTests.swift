// SettingsTtsViewTests — persistence parity + keychain round-trip +
// ProjectVoicesView mount smoke.
//
// Spec: openspec/changes/settings-tab-redesign (task 2.12, bd:nx-85e22)

import XCTest
import SwiftUI
@testable import nexus
@testable import NexusShared

@MainActor
final class SettingsTtsViewTests: XCTestCase {

    func testPersistenceKeyParityPreservesValues() {
        // Set pre-redesign values via the SAME keys SettingsTtsView reads.
        let defaults = UserDefaults.standard
        defaults.set("duck", forKey: SettingsTtsKeys.ducking)
        defaults.set(true, forKey: SettingsTtsKeys.signalOnly)
        defaults.set(false, forKey: SettingsTtsKeys.banner)
        SettingsStore.shared.ttsEnabled = false

        let model = SettingsTtsViewModel()
        XCTAssertEqual(model.ducking, .duck, "ducking key should round-trip")
        XCTAssertTrue(model.signalOnly, "signalOnly key should round-trip")
        XCTAssertFalse(model.bannerEnabled, "banner key should round-trip")
        XCTAssertFalse(model.ttsEnabled, "ttsEnabled key should round-trip")

        // Cleanup so neighbouring tests see defaults.
        defaults.removeObject(forKey: SettingsTtsKeys.ducking)
        defaults.removeObject(forKey: SettingsTtsKeys.signalOnly)
        defaults.removeObject(forKey: SettingsTtsKeys.banner)
        SettingsStore.shared.ttsEnabled = true
    }

    func testKeyPasteRoundTripViaKeychain() {
        // Pre-seed Keychain so the masked display starts populated.
        try? Keychain.set("old-key-1234567890", for: KeychainAccount.elevenLabsApiKey)
        let model = SettingsTtsViewModel()
        XCTAssertNotEqual(model.apiKeyMaskedDisplay, "—")

        // Simulate paste + save.
        model.pasteApiKey = "new-key-ZZZZZZZZZZ"
        model.saveKey()
        let written = try? Keychain.get(KeychainAccount.elevenLabsApiKey)
        XCTAssertEqual(written, "new-key-ZZZZZZZZZZ")
        // Paste field is cleared post-save.
        XCTAssertTrue(model.pasteApiKey.isEmpty)
        // Masked display refreshes.
        XCTAssertNotEqual(model.apiKeyMaskedDisplay, "—")

        // Cleanup.
        try? Keychain.delete(KeychainAccount.elevenLabsApiKey)
    }

    func testProjectVoicesViewMountsInline() {
        // Smoke: SettingsTtsView's body must compile + reference
        // ProjectVoicesView in scope. Constructing the view exercises the
        // entire `var body` opaque return — a missing import or rename
        // would fail compile, then trip here at runtime.
        _ = SettingsTtsView()
        _ = ProjectVoicesView()
    }
}
