// Notification — payload for the agent's `NotificationFired` SSE event
// and the canonical `GET /notifications` REST list.
//
// Spec: openspec/changes/add-nexus-shared-framework (task 1.2)
//       openspec/changes/agent-payload-completeness (severity + delivery_state)
//
// Source of truth: apps/agent/src/notifications/types.ts +
// apps/agent/src/routes/notifications.ts, mirrored in
// packages/core/src/types/notification.ts `NotificationEvent`.
// Cross-platform shape — used by macOS, iOS, watchOS clients.

import Foundation

/// Severity bucket emitted by the agent on every notification row.
/// Spec: agent-payload-completeness § Notification List Endpoint Exists.
public enum NotificationSeverity: String, Codable, Sendable, CaseIterable {
    case info
    case warn
    case error
}

/// Delivery lifecycle for a notification row — `pending` until the
/// downstream channel (TTS, push, etc.) acknowledges, `delivered` on
/// success, `failed` after retries exhausted.
public enum DeliveryState: String, Codable, Sendable, CaseIterable {
    case pending
    case delivered
    case failed
}

public struct NotificationEvent: Identifiable, Equatable, Hashable, Codable, Sendable {
    public var id: UUID
    public var body: String
    public var channel: String?
    public var title: String?
    public var emoji: String?
    /// Project slug the notification originated from. Nullable in the wire
    /// contract per packages/core NotificationEvent.
    public var project: String?
    public var receivedAt: Date

    /// Severity bucket. Non-optional in the model; older agents that omit
    /// the field decode as `.info`. Current-gen agents always emit one of
    /// `info|warn|error`. An UNKNOWN severity value (e.g. `"critical"`) is
    /// a hard decode failure — that's the gate's selectivity proof.
    public var severity: NotificationSeverity

    /// Delivery lifecycle state. Non-optional in the model; older agents
    /// that omit the field decode as `.pending`.
    public var deliveryState: DeliveryState

    public enum CodingKeys: String, CodingKey {
        case id
        case body
        case channel
        case title
        case emoji
        case project
        // `created_at` is the canonical REST shape (matches /sessions).
        // `received_at` / `receivedAt` are legacy SSE spellings kept for
        // backward compatibility — decode attempts in this order.
        case createdAt = "created_at"
        case receivedAtSnake = "received_at"
        case receivedAtCamel = "receivedAt"
        case severity
        case deliveryState = "delivery_state"
    }

    public init(
        id: UUID = UUID(),
        body: String,
        channel: String? = nil,
        title: String? = nil,
        emoji: String? = nil,
        project: String? = nil,
        receivedAt: Date = Date(),
        severity: NotificationSeverity = .info,
        deliveryState: DeliveryState = .pending
    ) {
        self.id = id
        self.body = body
        self.channel = channel
        self.title = title
        self.emoji = emoji
        self.project = project
        self.receivedAt = receivedAt
        self.severity = severity
        self.deliveryState = deliveryState
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        // `id` may arrive as a UUID-formatted String (the wire contract)
        // or as the synthesized UUID type. Tolerate both, fall back to a
        // fresh UUID only as a last resort.
        if let s = try? c.decode(String.self, forKey: .id),
           let u = UUID(uuidString: s) {
            self.id = u
        } else if let u = try? c.decode(UUID.self, forKey: .id) {
            self.id = u
        } else {
            self.id = UUID()
        }
        self.body = try c.decode(String.self, forKey: .body)
        self.channel = try c.decodeIfPresent(String.self, forKey: .channel)
        self.title = try c.decodeIfPresent(String.self, forKey: .title)
        self.emoji = try c.decodeIfPresent(String.self, forKey: .emoji)
        self.project = try c.decodeIfPresent(String.self, forKey: .project)

        // Date can come in as ISO-8601 string under any of three keys, or
        // as epoch-seconds Number under the legacy receivedAt key.
        self.receivedAt = NotificationEvent.decodeDate(c) ?? Date()

        // Severity / deliveryState: backward-tolerant for omission, STRICT
        // on unknown enum values. The strict decode is the gate's
        // selectivity proof — a payload emitting `severity: "critical"`
        // MUST throw, not silently degrade.
        if c.contains(.severity) {
            self.severity = try c.decode(NotificationSeverity.self, forKey: .severity)
        } else {
            self.severity = .info
        }
        if c.contains(.deliveryState) {
            self.deliveryState = try c.decode(DeliveryState.self, forKey: .deliveryState)
        } else {
            self.deliveryState = .pending
        }
    }

    /// Custom encoder — written to `created_at` (the canonical REST shape)
    /// in ISO-8601 with fractional seconds. The legacy `received_at` /
    /// `receivedAt` keys are decode-only tolerance hooks; we do NOT write
    /// them. Round-trip via `created_at` is the contract.
    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(id.uuidString, forKey: .id)
        try c.encode(body, forKey: .body)
        try c.encodeIfPresent(channel, forKey: .channel)
        try c.encodeIfPresent(title, forKey: .title)
        try c.encodeIfPresent(emoji, forKey: .emoji)
        try c.encodeIfPresent(project, forKey: .project)
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        try c.encode(f.string(from: receivedAt), forKey: .createdAt)
        try c.encode(severity, forKey: .severity)
        try c.encode(deliveryState, forKey: .deliveryState)
    }

    private static func decodeDate(
        _ c: KeyedDecodingContainer<CodingKeys>
    ) -> Date? {
        let f1 = ISO8601DateFormatter()
        f1.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        let f2 = ISO8601DateFormatter()
        f2.formatOptions = [.withInternetDateTime]
        let stringKeys: [CodingKeys] = [.createdAt, .receivedAtSnake, .receivedAtCamel]
        for key in stringKeys {
            if let s = try? c.decode(String.self, forKey: key) {
                if let d = f1.date(from: s) ?? f2.date(from: s) {
                    return d
                }
            }
        }
        // Epoch fallback (legacy SSE numeric form).
        if let n = try? c.decode(Double.self, forKey: .receivedAtCamel) {
            return Date(timeIntervalSince1970: n)
        }
        if let n = try? c.decode(Double.self, forKey: .receivedAtSnake) {
            return Date(timeIntervalSince1970: n)
        }
        if let n = try? c.decode(Double.self, forKey: .createdAt) {
            return Date(timeIntervalSince1970: n)
        }
        return nil
    }
}
