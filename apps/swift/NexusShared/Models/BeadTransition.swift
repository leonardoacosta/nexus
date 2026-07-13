// BeadTransition — the `BeadTransition` lifecycle-bus event payload.
//
// Spec: openspec/changes/add-project-status-snapshots/ (task 3.1)
//
// Source of truth: packages/core/src/types/project-status.ts
// (`beadTransitionPayload` Zod schema) + apps/agent/src/services/lifecycle-bus.ts
// (`BeadTransitionPayload`). Emitted only when a project's unlinked
// ready/blocked bead counts change, and forwarded onto the general
// `/events/stream` SSE endpoint via the `subscribeStreamToBus` wildcard
// (`onAny`) — so the wire event name is the bus key `BeadTransition` and the
// frame data is the full `LifecycleEnvelope` (`{ event, payload, seq, ts }`).
//
// Wire fields are already camelCase (`beadsReadyUnlinked` /
// `beadsBlockedUnlinked`), so no snake_case CodingKeys bridging is needed —
// only the `at` timestamp gets the permissive ISO-8601 decode HealthSnapshot
// established. Decode-only, no dashboard surface (per the spec's UI batch).

import Foundation

/// The unlinked ready/blocked bead counts carried on either side of a
/// `BeadTransition`. Mirrors `@nexus/core`'s `beadUnlinkedCounts`.
public struct BeadUnlinkedCounts: Equatable, Hashable, Codable, Sendable {
    public var beadsReadyUnlinked: Int
    public var beadsBlockedUnlinked: Int

    public init(beadsReadyUnlinked: Int, beadsBlockedUnlinked: Int) {
        self.beadsReadyUnlinked = beadsReadyUnlinked
        self.beadsBlockedUnlinked = beadsBlockedUnlinked
    }
}

/// A decoded `BeadTransition` lifecycle event — project, the counts before and
/// after the change, and the change time. Symmetric with the agent's
/// `SpecTransition`; the change-only snapshot comparison is the emission gate,
/// so a received event always represents a real count change.
public struct BeadTransition: Equatable, Hashable, Codable, Sendable {
    public var project: String
    public var previous: BeadUnlinkedCounts
    public var current: BeadUnlinkedCounts
    public var at: Date

    public enum CodingKeys: String, CodingKey {
        case project
        case previous
        case current
        case at
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        self.project = try c.decode(String.self, forKey: .project)
        self.previous = try c.decode(BeadUnlinkedCounts.self, forKey: .previous)
        self.current = try c.decode(BeadUnlinkedCounts.self, forKey: .current)
        if let s = try? c.decode(String.self, forKey: .at) {
            let f1 = ISO8601DateFormatter()
            f1.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
            let f2 = ISO8601DateFormatter()
            f2.formatOptions = [.withInternetDateTime]
            self.at = f1.date(from: s) ?? f2.date(from: s) ?? Date()
        } else {
            self.at = Date()
        }
    }

    public init(
        project: String,
        previous: BeadUnlinkedCounts,
        current: BeadUnlinkedCounts,
        at: Date
    ) {
        self.project = project
        self.previous = previous
        self.current = current
        self.at = at
    }
}

// MARK: - SSE payload decoder

extension SSEEvent {
    /// `BeadTransition` — the agent forwards the full `LifecycleEnvelope` as the
    /// frame data, so the payload lives under `payload` (matching the
    /// `decodeNotification` envelope-unwrap convention). Returns nil if the
    /// frame cannot be parsed (fail-open — a malformed frame is dropped, never
    /// crashes the stream).
    public func decodeBeadTransition(
        using decoder: JSONDecoder = JSONDecoder()
    ) -> BeadTransition? {
        guard let bytes = data.data(using: .utf8) else { return nil }
        guard let env = try? JSONSerialization.jsonObject(with: bytes) as? [String: Any]
        else { return nil }
        let payload = (env["payload"] as? [String: Any]) ?? env
        guard let nested = try? JSONSerialization.data(withJSONObject: payload) else {
            return nil
        }
        return try? decoder.decode(BeadTransition.self, from: nested)
    }
}
