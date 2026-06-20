// FleetPresenceIndicator — compact dashboard element showing the resolved
// live-console machine and where the next notification will route.
//
// Spec: openspec/changes/cross-machine-delivery (Phase 1.6),
// requirement "Fleet Presence Dashboard Indicator" (nx-4vc67).
//
// Reads `GET /presence/fleet` (NexusClient.fetchFleetPresence) on appear and
// derives a routing summary:
//   - live console == local machine -> "notifications → this Mac"
//   - live console == a peer         -> "live console: <peer>"
//                                       "notifications → <peer>"
//
// The string derivation lives in the PURE `FleetRouteSummary.derive` so it is
// unit-testable from a stubbed fleet response with no live agent
// (FleetPresenceIndicatorTests). The View is a thin shell over it.

import SwiftUI
import NexusShared

/// Pure, injectable view-model for the indicator. `derive` maps a fleet
/// response to the two display strings — the testable core (nx-f3w74).
public struct FleetRouteSummary: Equatable, Sendable {
    /// Headline: the resolved live-console machine, framed for the user.
    public var consoleLine: String
    /// Sub-line: where the next notification routes.
    public var routeLine: String
    /// True when the live console is THIS Mac (routes locally, no forward).
    public var isLocal: Bool

    public init(consoleLine: String, routeLine: String, isLocal: Bool) {
        self.consoleLine = consoleLine
        self.routeLine = routeLine
        self.isLocal = isLocal
    }

    /// Derive the summary from a fleet response. Pure — no I/O, no clock.
    ///
    /// `liveConsole == localMachine` (or an empty/unresolved live console that
    /// falls back to local) renders "this Mac"; a peer renders that peer's name
    /// in both the console headline and the routing destination.
    public static func derive(from response: FleetPresenceResponse) -> FleetRouteSummary {
        let local = response.localMachine
        // An empty liveConsole means the agent resolved nothing on-console and
        // fell back to local; treat it as local so the indicator never shows a
        // blank destination.
        let resolved = response.liveConsole.isEmpty ? local : response.liveConsole
        let isLocal = resolved == local || resolved.isEmpty

        if isLocal {
            return FleetRouteSummary(
                consoleLine: "live console: this Mac",
                routeLine: "notifications → this Mac",
                isLocal: true
            )
        }
        return FleetRouteSummary(
            consoleLine: "live console: \(resolved)",
            routeLine: "notifications → \(resolved)",
            isLocal: false
        )
    }

    /// The empty/loading placeholder before the first fetch resolves.
    public static let placeholder = FleetRouteSummary(
        consoleLine: "live console: …",
        routeLine: "resolving fleet presence",
        isLocal: true
    )
}

struct FleetPresenceIndicator: View {
    /// Injected for previews / tests; defaults to the resolved-endpoint client.
    /// Qualified `NexusShared.NexusClient` — the nexus-mac target also compiles
    /// the legacy `actor NexusClient` (apps/swift/nexus/nexus/NexusClient.swift),
    /// so an unqualified name resolves to the WRONG type (no fetchFleetPresence).
    let client: NexusShared.NexusClient

    @State private var summary: FleetRouteSummary = .placeholder
    @State private var loaded: Bool = false

    init(client: NexusShared.NexusClient = NexusShared.NexusClient()) {
        self.client = client
    }

    var body: some View {
        HStack(spacing: 8) {
            Image(systemName: icon)
                .imageScale(.medium)
                .foregroundStyle(tint)

            VStack(alignment: .leading, spacing: 1) {
                Text(summary.consoleLine)
                    .font(.caption.monospaced())
                    .foregroundStyle(Color.nx.ink2)
                Text(summary.routeLine)
                    .font(.caption2.monospaced())
                    .foregroundStyle(loaded ? Color.nx.ink3 : Color.nx.ink4)
            }
        }
        .padding(.horizontal, 8)
        .padding(.vertical, 5)
        .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 8))
        .help("Resolved live console and notification routing destination")
        .accessibilityIdentifier("fleet-presence-indicator")
        .accessibilityElement(children: .combine)
        .accessibilityLabel("\(summary.consoleLine), \(summary.routeLine)")
        .task { await refresh() }
    }

    private var icon: String {
        summary.isLocal ? "laptopcomputer" : "arrow.up.forward.app"
    }

    private var tint: Color {
        guard loaded else { return Color.nx.ink4 }
        return summary.isLocal ? Color.nx.phosphor : Color.nx.amber
    }

    /// Fetch + derive. Best-effort: a nil response keeps the last-known-good
    /// summary (or the placeholder on first load), matching the client's
    /// degrade-don't-throw contract.
    private func refresh() async {
        if let response = await client.fetchFleetPresence() {
            summary = FleetRouteSummary.derive(from: response)
            loaded = true
        }
    }
}

#Preview("Routes to this Mac") {
    // Live console resolves to the local machine -> "this Mac".
    let summary = FleetRouteSummary.derive(
        from: FleetPresenceResponse(
            machines: [
                FleetMachine(machine: "studio", onConsole: true, macActive: true, macLocked: false),
                FleetMachine(machine: "homelab", onConsole: false),
            ],
            liveConsole: "studio",
            localMachine: "studio"
        )
    )
    return _FleetIndicatorPreviewShell(summary: summary)
        .padding()
        .background(Color.nx.substrate)
}

#Preview("Routes to a peer") {
    // Live console resolves to a peer Mac -> forward to that peer.
    let summary = FleetRouteSummary.derive(
        from: FleetPresenceResponse(
            machines: [
                FleetMachine(machine: "studio", onConsole: false),
                FleetMachine(machine: "homelab", onConsole: true, macActive: true, macLocked: false),
            ],
            liveConsole: "homelab",
            localMachine: "studio"
        )
    )
    return _FleetIndicatorPreviewShell(summary: summary)
        .padding()
        .background(Color.nx.substrate)
}

/// Preview-only static shell that renders a fixed summary (avoids a live fetch
/// in the canvas). Mirrors the View's layout 1:1.
private struct _FleetIndicatorPreviewShell: View {
    let summary: FleetRouteSummary
    var body: some View {
        HStack(spacing: 8) {
            Image(systemName: summary.isLocal ? "laptopcomputer" : "arrow.up.forward.app")
                .imageScale(.medium)
                .foregroundStyle(summary.isLocal ? Color.nx.phosphor : Color.nx.amber)
            VStack(alignment: .leading, spacing: 1) {
                Text(summary.consoleLine).font(.caption.monospaced()).foregroundStyle(Color.nx.ink2)
                Text(summary.routeLine).font(.caption2.monospaced()).foregroundStyle(Color.nx.ink3)
            }
        }
        .padding(.horizontal, 8).padding(.vertical, 5)
        .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 8))
    }
}
