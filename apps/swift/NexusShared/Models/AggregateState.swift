// AggregateState — mutually-exclusive states the menu bar icon reflects.
//
// Spec: openspec/changes/add-nexus-shared-framework (task 1.2)
//
// The TTS-muted overlay is a separate boolean composed on top of any of
// the base states. `derive` is the single source of truth — when porting
// this to iOS / watchOS, call into NexusShared.AggregateState.derive
// rather than re-implementing.

import Foundation

public enum AggregateState: String, Equatable, Hashable, Codable, Sendable {
    case active       // peer reachable AND >= 1 session running
    case idle         // peer reachable AND zero sessions
    case stale        // last heartbeat 30s < age <= 5min
    case unreachable  // last heartbeat > 5min OR explicit PeerLost
}

extension AggregateState {
    /// Derive the variant from raw inputs. Nonisolated so any actor / view
    /// model can call it without hopping to a global actor.
    public static func derive(
        lastHeartbeat: Date?,
        sessionCount: Int,
        peerLost: Bool,
        now: Date = Date()
    ) -> AggregateState {
        if peerLost { return .unreachable }
        guard let hb = lastHeartbeat else { return .unreachable }
        let age = now.timeIntervalSince(hb)
        if age > 300 { return .unreachable }     // > 5 min
        if age > 30  { return .stale }           // 30 s ..= 5 min
        return sessionCount > 0 ? .active : .idle
    }

    public var accessibilityLabel: String {
        switch self {
        case .active:      return "Nexus: peer active"
        case .idle:        return "Nexus: peer idle"
        case .stale:       return "Nexus: peer stale heartbeat"
        case .unreachable: return "Nexus: peer unreachable"
        }
    }
}
