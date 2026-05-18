// Spec: swift-owns-elevenlabs-synth (task 1.9)
//
// End-to-end test stub: fire a notification at the agent over the socket
// dispatcher, assert that NotificationFired event arrives on the Mac side
// without an audioBase64 field, and verify the listener can synthesize
// independently using the Keychain-stored key.
//
// Implementation deferred to a real XCTest target wired into nexus-mac.
// See openspec/changes/swift-owns-elevenlabs-synth/proposal.md for the
// expected event payload contract.

import XCTest

@testable import NexusShared

final class AgentNotificationIntegrationTest: XCTestCase {
    /// Smoke: Keychain helpers round-trip without crashing.
    func testKeychainSetGetDelete() throws {
        try Keychain.set("test-value", for: "nexus.test.placeholder")
        XCTAssertEqual(try Keychain.get("nexus.test.placeholder"), "test-value")
        try Keychain.delete("nexus.test.placeholder")
    }
}
