// AttachSheet — the PTY viewer, summoned as a sheet rather than visited.
//
// Spec: openspec/changes/refocus-board-shell (task 3.3, design § 06)
//
// Re-homes all of `PtyViewer` (writer-claim, Stream/Full mode toggle, adaptive
// resize) into a sheet presented over the dimmed board. PtyViewer already
// owns the header + mode toggle + close affordance; AttachSheet just supplies
// the session context and wires dismissal (Esc detaches, board state intact).

import SwiftUI
import NexusShared

struct AttachSheet: View {
    let session: Session
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        PtyViewer(
            sessionId: session.id,
            sessionLabel: Session.projectLabel(for: session),
            sessionMeta: Session.metaLine(for: session),
            sessionType: session.sessionType,
            onClose: { dismiss() }
        )
        .frame(minWidth: 760, minHeight: 480)
        .accessibilityIdentifier("attach-sheet")
    }
}
