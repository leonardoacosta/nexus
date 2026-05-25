// PtySessionPickerTests — pin the PTY live-session picker contract.
//
// Spec: openspec/changes/swift-client-polish (task 2.1, beads nx-zqntf)
//
// Wave-3 replaced the PtyViewer's free-text session-id field with a
// live-session picker populated from `observer.activeSessions`
// (apps/swift/nexus-mac/Sources/AppNavigation.swift `ptyDetail`). Two
// behaviours are verified:
//
//   1. Option derivation — the picker's options derive from the live
//      session list: one tag per session id, labelled via
//      `Session.projectLabel(for:)`, plus the leading "Select a session"
//      empty tag. A stale id that is no longer in the live list is NOT
//      offered.
//
//   2. Selection → attach mapping — selecting a picker tag resolves to the
//      matching live session via `liveSessions.first(where: { $0.id == sel })`,
//      which drives the `PtyViewer(sessionId:sessionLabel:sessionMeta:sessionType:)`
//      attach call. A selection pointing at a since-dropped session falls
//      through to the empty-state prompt rather than attaching to a dead id.
//
// Test design note (same discipline as PtyAttachTests.swift)
// ──────────────────────────────────────────────────────────
// The picker's option-derivation + selection-resolution logic lives in
// `ptyDetail` (nexus-mac target, which NexusSharedTests does NOT link). We
// mirror the EXACT decision logic in a tiny `PtySessionPicker` helper —
// identical to AppNavigation.swift's `ptyDetail`:
//
//   options:   ["" -> "Select a session"] + liveSessions.map { ($0.id, label) }
//   resolve:   liveSessions.first(where: { $0.id == ptySessionId })
//   label:     Session.projectLabel(for:)   (the REAL NexusShared helper)
//   meta:      Session.metaLine(for:)        (the REAL NexusShared helper)
//
// `Session`, `projectLabel`, and `metaLine` are the production NexusShared
// types/helpers (reached via `@testable import`), so the label/meta the
// attach call passes are pinned to the same code the view uses. Keep the
// helper in lockstep with AppNavigation.swift's `ptyDetail`.

import XCTest
@testable import NexusShared

final class PtySessionPickerTests: XCTestCase {

    // MARK: - Fixtures

    private func makeSession(
        id: String,
        gitOwnerRepo: String? = nil,
        projectId: String? = nil,
        cwd: String? = nil,
        pid: Int? = nil,
        machine: String? = nil,
        sessionType: String? = "managed"
    ) -> Session {
        Session(
            id: id,
            projectId: projectId,
            machine: machine,
            pid: pid,
            cwd: cwd,
            gitOwnerRepo: gitOwnerRepo,
            sessionType: sessionType
        )
    }

    // MARK: - Test 1: options derive from the live session list

    func testOptionsDeriveFromLiveSessions() {
        let live = [
            makeSession(id: "s-1", gitOwnerRepo: "leonardoacosta/oo"),
            makeSession(id: "s-2", projectId: "tc-dashboard"),
            makeSession(id: "s-3", cwd: "/home/leo/dev/nx"),
        ]
        let picker = PtySessionPicker(liveSessions: live)

        // The leading empty tag plus one tag per live session.
        XCTAssertEqual(picker.options.count, live.count + 1,
                       "picker offers an empty 'Select a session' tag + one per live session")

        // First option is the empty-selection placeholder.
        XCTAssertEqual(picker.options[0].tag, "",
                       "the first option must be the empty placeholder tag")
        XCTAssertEqual(picker.options[0].label, "Select a session")

        // The remaining tags are exactly the live session ids, in order.
        let sessionTags = picker.options.dropFirst().map(\.tag)
        XCTAssertEqual(Array(sessionTags), ["s-1", "s-2", "s-3"],
                       "each live session contributes exactly its id as a tag")

        // Labels are derived via the REAL Session.projectLabel ladder.
        let labels = picker.options.dropFirst().map(\.label)
        XCTAssertEqual(Array(labels), ["leonardoacosta/oo", "tc-dashboard", "nx"],
                       "option labels must come from Session.projectLabel(for:)")
    }

    func testEmptyLiveListOffersOnlyTheEmptyTag() {
        let picker = PtySessionPicker(liveSessions: [])
        XCTAssertEqual(picker.options.count, 1,
                       "with no live sessions only the empty placeholder is offered")
        XCTAssertEqual(picker.options[0].tag, "")
        // Production disables the picker + shows the "No live sessions" prompt.
        XCTAssertTrue(picker.isDisabled,
                      "an empty live list must disable the picker (no selectable session)")
    }

    func testStaleIdNotOfferedAsAnOption() {
        let live = [makeSession(id: "s-1"), makeSession(id: "s-2")]
        let picker = PtySessionPicker(liveSessions: live)
        let offeredTags = Set(picker.options.map(\.tag))
        XCTAssertFalse(offeredTags.contains("s-stale"),
                       "a session id absent from the live list is never offered")
    }

    // MARK: - Test 2: selection → attach mapping

    func testSelectingLiveSessionDrivesAttach() {
        let live = [
            makeSession(id: "s-1", gitOwnerRepo: "leonardoacosta/oo", pid: 4321,
                        machine: "homelab"),
            makeSession(id: "s-2", projectId: "tc-dashboard"),
        ]
        let picker = PtySessionPicker(liveSessions: live)

        // Selecting s-1's tag resolves to an attach intent carrying the SAME
        // id/label/meta/type the Sessions tab passes to PtyViewer.
        let attach = picker.attachIntent(forSelection: "s-1")
        let resolved = try? XCTUnwrap(attach)
        XCTAssertEqual(resolved?.sessionId, "s-1")
        XCTAssertEqual(resolved?.sessionLabel, "leonardoacosta/oo",
                       "attach label must match Session.projectLabel(for:)")
        XCTAssertEqual(resolved?.sessionMeta, "pid 4321 · homelab",
                       "attach meta must match Session.metaLine(for:)")
        XCTAssertEqual(resolved?.sessionType, "managed",
                       "attach must carry the live session's sessionType")
    }

    func testEmptySelectionProducesNoAttach() {
        let live = [makeSession(id: "s-1")]
        let picker = PtySessionPicker(liveSessions: live)
        // The "Select a session" placeholder ("") must not attach to anything.
        XCTAssertNil(picker.attachIntent(forSelection: ""),
                     "the empty placeholder selection must produce no attach intent")
    }

    func testStaleSelectionFallsThroughToEmptyState() {
        // Selection points at a session that has since dropped off the live
        // list (agent restart / session ended). Production resolves the
        // selection against the live list and falls through to the empty-state
        // prompt rather than attaching to a dead id.
        let live = [makeSession(id: "s-1"), makeSession(id: "s-2")]
        let picker = PtySessionPicker(liveSessions: live)
        XCTAssertNil(picker.attachIntent(forSelection: "s-gone"),
                     "a selection absent from the live list must NOT attach")
    }

    func testSelectionUpdatesAttachWhenLiveListChanges() {
        // A session selected while live, then dropped from the next list,
        // must stop attaching — the picker re-resolves against the CURRENT
        // live list every render.
        let before = PtySessionPicker(liveSessions: [makeSession(id: "s-1")])
        XCTAssertNotNil(before.attachIntent(forSelection: "s-1"))

        let after = PtySessionPicker(liveSessions: [makeSession(id: "s-2")])
        XCTAssertNil(after.attachIntent(forSelection: "s-1"),
                     "once s-1 leaves the live list, selecting it no longer attaches")
        XCTAssertNotNil(after.attachIntent(forSelection: "s-2"))
    }
}

// MARK: - Mirror of AppNavigation.swift `ptyDetail` picker logic

/// The intent that drives `PtyViewer(sessionId:sessionLabel:sessionMeta:sessionType:)`
/// when a live session is selected. Mirrors the four args the production
/// `ptyDetail` passes through.
private struct PtyAttachIntent: Equatable {
    let sessionId: String
    let sessionLabel: String
    let sessionMeta: String
    let sessionType: String?
}

/// A single picker option (SwiftUI `Text(label).tag(tag)`).
private struct PtyPickerOption: Equatable {
    let tag: String
    let label: String
}

/// Mirror of AppNavigation.swift's `ptyDetail` picker derivation + selection
/// resolution lifted out of nexus-mac so the CONTRACT is unit-testable from
/// NexusSharedTests (which links NexusShared, not the macOS app). Decision
/// logic is intentionally identical to `ptyDetail`:
///
///   - options:  leading `("", "Select a session")` + `liveSessions.map`
///               `{ ($0.id, Session.projectLabel(for: $0)) }`
///   - disabled: `liveSessions.isEmpty`
///   - resolve:  `liveSessions.first(where: { $0.id == selection })`
///   - attach:   `PtyViewer(sessionId: s.id,
///                          sessionLabel: Session.projectLabel(for: s),
///                          sessionMeta: Session.metaLine(for: s),
///                          sessionType: s.sessionType)`
///
/// Keep in lockstep with apps/swift/nexus-mac/Sources/AppNavigation.swift.
private struct PtySessionPicker {
    let liveSessions: [Session]

    var options: [PtyPickerOption] {
        var opts = [PtyPickerOption(tag: "", label: "Select a session")]
        opts.append(contentsOf: liveSessions.map { session in
            PtyPickerOption(tag: session.id, label: Session.projectLabel(for: session))
        })
        return opts
    }

    var isDisabled: Bool { liveSessions.isEmpty }

    /// Resolve the picker selection against the CURRENT live list. Returns the
    /// attach intent when the selection names a live session; nil (→ empty
    /// state) for the placeholder or a stale id.
    func attachIntent(forSelection selection: String) -> PtyAttachIntent? {
        guard let session = liveSessions.first(where: { $0.id == selection }) else {
            return nil
        }
        return PtyAttachIntent(
            sessionId: session.id,
            sessionLabel: Session.projectLabel(for: session),
            sessionMeta: Session.metaLine(for: session),
            sessionType: session.sessionType
        )
    }
}
