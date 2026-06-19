// SettingsRoutingViewTests — simulator winner selection + source persistence.
//
// Spec: openspec/changes/context-aware-routing (task nx-dimqx)
//
// Verifies the pure RoutingSimulator mirrors the agent's first-match-wins
// ordering (Rule 1 active-Mac beats bedtime — decision Q1; in-meeting -> Rule 2
// hold; all-unknown -> terminal) and that toggling a presence source persists
// through SettingsStore.

import XCTest
@testable import nexus
@testable import NexusShared

@MainActor
final class SettingsRoutingViewTests: XCTestCase {

    private let rules = RoutingRule.phase1Defaults

    // MARK: - Simulator: first-match-wins

    func testActiveMacWinsRule1EvenAtBedtime() {
        // macActive + not in meeting + bedtime -> Rule 1 (active Mac) must win,
        // NOT a bedtime rule (Q1: active Mac beats bedtime).
        var v = SimVector()
        v.macActive = .yes
        v.inMeeting = .no
        v.bedtime = .yes

        let winner = RoutingSimulator.winner(for: v, rules: rules)
        XCTAssertEqual(winner?.id, "rule-active-mac", "active Mac must win even at bedtime")
        XCTAssertEqual(winner?.action, .bannerAndTTS)
        XCTAssertEqual(winner?.priority, 0)
    }

    func testInMeetingSelectsRule2Hold() {
        // In meeting (mac active unknown/false) -> Rule 2 meeting-hold.
        var v = SimVector()
        v.macActive = .no
        v.inMeeting = .yes

        let winner = RoutingSimulator.winner(for: v, rules: rules)
        XCTAssertEqual(winner?.id, "rule-meeting-hold")
        XCTAssertEqual(winner?.action, .holdForMeeting)
    }

    func testActiveMacInMeetingDoesNotTakeRule1() {
        // Rule 1 requires inMeeting == false; an active Mac that is ALSO in a
        // meeting falls through to Rule 2 (the meeting-hold), not Rule 1.
        var v = SimVector()
        v.macActive = .yes
        v.inMeeting = .yes

        let winner = RoutingSimulator.winner(for: v, rules: rules)
        XCTAssertEqual(winner?.id, "rule-meeting-hold",
                       "active+in-meeting must hold, not banner+TTS")
    }

    func testAllUnknownFallsToTerminal() {
        // Every field unknown -> no presence rule's predicate is satisfiable,
        // so the terminal fallback wins (never silently dropped).
        let v = SimVector()  // all .unknown
        let winner = RoutingSimulator.winner(for: v, rules: rules)
        XCTAssertEqual(winner?.id, "rule-terminal")
        XCTAssertEqual(winner?.action, .terminalDigest)
    }

    func testUnknownMacActiveDoesNotFireRule1() {
        // Rule 1 requires macActive == true; an UNKNOWN macActive must NOT
        // satisfy it (fail-safe: the engine can't confirm presence).
        var v = SimVector()
        v.macActive = .unknown
        v.inMeeting = .no
        let winner = RoutingSimulator.winner(for: v, rules: rules)
        XCTAssertNotEqual(winner?.id, "rule-active-mac")
        XCTAssertEqual(winner?.id, "rule-terminal")
    }

    func testDisabledRuleIsSkipped() {
        // Disable Rule 1; an active Mac then falls through to the terminal.
        var custom = rules
        custom[0].enabled = false
        var v = SimVector()
        v.macActive = .yes
        v.inMeeting = .no
        let winner = RoutingSimulator.winner(for: v, rules: custom)
        XCTAssertEqual(winner?.id, "rule-terminal")
    }

    // MARK: - Source toggle persistence

    func testToggleSourcePersistsThroughSettingsStore() {
        let suite = UserDefaults(suiteName: "test.routing.sources")!
        suite.removePersistentDomain(forName: "test.routing.sources")
        let store = SettingsStore(defaults: suite)
        let model = SettingsRoutingViewModel(store: store)

        // calendarBusy is OFF by default (not in defaultEnabled).
        XCTAssertFalse(model.isSourceEnabled(.calendarBusy))

        model.toggleSource(.calendarBusy, on: true)
        XCTAssertTrue(model.isSourceEnabled(.calendarBusy))
        // Persisted through the store, not just the in-memory model.
        XCTAssertTrue(store.enabledPresenceSources.contains(.calendarBusy))

        model.toggleSource(.calendarBusy, on: false)
        XCTAssertFalse(store.enabledPresenceSources.contains(.calendarBusy))

        suite.removePersistentDomain(forName: "test.routing.sources")
    }

    func testRoutingRulesDefaultSeedRoundTripsThroughStore() {
        let suite = UserDefaults(suiteName: "test.routing.rules")!
        suite.removePersistentDomain(forName: "test.routing.rules")
        let store = SettingsStore(defaults: suite)

        // Empty store -> the Phase-1 seed.
        XCTAssertEqual(store.routingRules.map(\.id),
                       RoutingRule.phase1Defaults.map(\.id))

        // Persist a reordered set; priority re-stamps to index.
        var reordered = Array(store.routingRules.reversed())
        store.routingRules = reordered
        reordered = store.routingRules
        XCTAssertEqual(reordered.first?.priority, 0)
        XCTAssertEqual(reordered.last?.priority, reordered.count - 1)

        suite.removePersistentDomain(forName: "test.routing.rules")
    }
}
