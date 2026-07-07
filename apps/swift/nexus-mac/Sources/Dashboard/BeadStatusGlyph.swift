// BeadStatusGlyph — shared bead-status glyph + small chips for the Specs and
// Roadmap surfaces.
//
// Spec: openspec/changes/add-bead-proposal-roadmap-surface (tasks 2.3, 2.4)
//
// Reuses the established "filled Circle colored by status" glyph convention
// already used by SpecRow.statusBadge (SpecsView.swift) and CredentialsView /
// IntegrationsView — rather than inventing a new shape. The color map is
// bead-status-specific (open / in_progress / blocked / closed) because the
// spec-status palette (approved / draft / archived) doesn't cover bead states.

import AppKit
import SwiftUI
import NexusShared

/// Canonical bead-status → color mapping. Mirrors the fleet's status semantics
/// (green = done, blue = active, red = blocked, gray = queued/unknown).
func beadStatusColor(_ status: String) -> Color {
    switch status.lowercased() {
    case "closed", "done":          return .green
    case "in_progress", "in-progress", "active": return .blue
    case "blocked":                 return .red
    case "open", "ready":           return .gray
    default:                        return .secondary
    }
}

/// Filled-circle status glyph — the same visual convention as
/// `SpecRow.statusBadge`. Hover surfaces the raw status string.
struct BeadStatusGlyph: View {
    let status: String

    var body: some View {
        Circle()
            .fill(beadStatusColor(status))
            .frame(width: 8, height: 8)
            .help("status: \(status)")
            .accessibilityLabel("bead status \(status)")
    }
}

/// Tappable monospaced bead-id chip. Click copies the id to the pasteboard so
/// the user can paste it into a `bd show` / terminal. `role` ("epic" /
/// "feature") tints + labels the chip. add-bead-proposal-roadmap-surface
/// task 2.3 — "tappable epic/feature bead ids".
struct BeadIdChip: View {
    let ref: BeadRef
    let role: String

    private var roleColor: Color {
        role == "epic" ? .purple : .teal
    }

    var body: some View {
        Button {
            let pb = NSPasteboard.general
            pb.clearContents()
            pb.setString(ref.id, forType: .string)
        } label: {
            HStack(spacing: 3) {
                Text(role.uppercased())
                    .font(.system(size: 8, weight: .semibold, design: .monospaced))
                    .tracking(0.5)
                    .foregroundStyle(roleColor)
                Text(ref.id)
                    .font(.caption2.monospaced())
                    .foregroundStyle(.primary)
            }
            .padding(.horizontal, 5)
            .padding(.vertical, 1)
            .background(roleColor.opacity(0.12))
            .clipShape(RoundedRectangle(cornerRadius: 3))
        }
        .buttonStyle(.borderless)
        .help("\(role): \(ref.title) — click to copy \(ref.id)")
        .accessibilityIdentifier("bead-id-chip-\(ref.id)")
    }
}

/// "N ready" chip surfaced next to a proposal's progress bar. Hidden by the
/// caller when the ready count is 0.
struct ReadyCountChip: View {
    let count: Int

    var body: some View {
        Text("\(count) ready")
            .font(.caption2.monospacedDigit())
            .foregroundStyle(.green)
            .padding(.horizontal, 5)
            .padding(.vertical, 1)
            .background(Color.green.opacity(0.14))
            .clipShape(Capsule())
            .accessibilityIdentifier("bead-ready-chip")
    }
}

/// One row in the Specs tab's "Unlinked open beads" section — the bead's
/// status glyph, id, project tag, and title. add-bead-proposal-roadmap-
/// surface task 2.3.
struct UnlinkedBeadRow: View {
    let project: String
    let bead: UnlinkedBead

    var body: some View {
        HStack(spacing: 6) {
            BeadStatusGlyph(status: bead.status)
            Text(bead.id)
                .font(.caption2.monospaced())
                .foregroundStyle(.secondary)
            Text(project)
                .font(.system(size: 8, weight: .semibold, design: .monospaced))
                .foregroundStyle(.tertiary)
            Text(bead.title)
                .font(.caption2)
                .foregroundStyle(.primary)
                .lineLimit(1)
                .truncationMode(.tail)
            Spacer(minLength: 0)
        }
    }
}
