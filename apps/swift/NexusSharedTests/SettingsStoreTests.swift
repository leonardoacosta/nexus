// SettingsStoreTests — round-trip the typed preferences through an
// in-memory UserDefaults suite so we don't pollute the runtime defaults.
//
// Spec: openspec/changes/add-nexus-shared-framework (task 1.7)

import XCTest
@testable import NexusShared

final class SettingsStoreTests: XCTestCase {
    private var defaults: UserDefaults!
    private var store: SettingsStore!

    override func setUp() {
        super.setUp()
        let suite = "nexus-shared-tests-\(UUID().uuidString)"
        defaults = UserDefaults(suiteName: suite)!
        store = SettingsStore(defaults: defaults)
    }

    override func tearDown() {
        defaults.removePersistentDomain(forName: defaults.dictionaryRepresentation()
            .keys.sorted().joined())
        super.tearDown()
    }

    func testTtsEnabledDefaultsTrue() {
        XCTAssertTrue(store.ttsEnabled)
    }

    func testTtsProviderDefaultsElevenLabs() {
        XCTAssertEqual(store.ttsProvider, "elevenlabs")
    }

    func testRoundTripVoiceId() {
        XCTAssertNil(store.elevenLabsVoiceId)
        store.elevenLabsVoiceId = "21m00Tcm4TlvDq8ikWAM"
        XCTAssertEqual(store.elevenLabsVoiceId, "21m00Tcm4TlvDq8ikWAM")
    }

    func testProcessProbeFallbackDefaultsFalse() {
        XCTAssertFalse(store.processProbeFallback)
        store.processProbeFallback = true
        XCTAssertTrue(store.processProbeFallback)
    }
}
