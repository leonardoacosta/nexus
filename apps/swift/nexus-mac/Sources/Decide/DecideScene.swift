// DecideScene — the MenuBarExtra surface for the decide pilot. A SECOND menubar
// item (alongside the dashboard's) whose window-style popover hosts the decide
// deck. Wired into `nexusApp.body` (nexus/nexus/nexusApp.swift).
//
// Spec: openspec/changes/add-decide-flow-menubar (nexus-mac task 2.6).
//
// Level 1 (label): a compact queue-head rendering — an SF Symbol + the truncated
// head action. NO count, rate, or backlog total (anti-bias). Before the popover
// is first opened the session is empty, so the label shows the neutral symbol.
// Level 2 (popover): DecideDeckView — one card at a time, 10 per session.

import SwiftUI
import NexusShared

struct DecideScene: Scene {
    /// Session state is shared between the label (queue-head) and the popover
    /// (the deck). Held at Scene scope so both read the same @Observable instance.
    @State private var session = DecideSession()

    /// Qualified NexusShared client — the nexus-mac target ALSO compiles the
    /// legacy `nexus/nexus/NexusClient.swift`, so the type must be namespaced.
    private let client = NexusShared.NexusClient()

    var body: some Scene {
        MenuBarExtra {
            DecideDeckView(session: session, client: client)
        } label: {
            DecideMenuLabel(session: session)
        }
        .menuBarExtraStyle(.window)
    }
}

/// Compact menubar label: SF Symbol + truncated head action. Renders the current
/// session head when one exists; the neutral "checklist" symbol otherwise. No
/// numeric badge — the anti-bias invariant forbids counts in the flow.
private struct DecideMenuLabel: View {
    let session: DecideSession

    var body: some View {
        if let head = session.current, let action = head.verdict?.action, !action.isEmpty {
            HStack(spacing: 4) {
                Image(systemName: "checklist")
                Text(compact(action, head.title))
                    .lineLimit(1)
                    .truncationMode(.tail)
            }
            .accessibilityIdentifier("decide-menu-label")
            .accessibilityLabel("Decide: \(action) \(head.title)")
        } else {
            Image(systemName: "checklist")
                .accessibilityIdentifier("decide-menu-label")
                .accessibilityLabel("Decide queue")
        }
    }

    /// "delegate: AB#4821 · Auth…" trimmed to a menubar-friendly width.
    private func compact(_ action: String, _ title: String) -> String {
        let head = "\(action): \(title)"
        return head.count > 26 ? String(head.prefix(25)) + "…" : head
    }
}
