// ScriptError — Codable mirror of an agent script_errors row + recent
// failed notification deliveries unified into one feed.
//
// Spec: openspec/changes/swift-dashboard-feature-parity (task 1.6)
// bd:nx-gaquu
//
// Source of truth: apps/agent/src/routes/failures-route.ts (the
// `top_errors` array) plus apps/agent/src/notifications/* failure log.
// Cross-platform — also rendered by iOS + watchOS triage surfaces.

import Foundation

public struct ScriptError: Identifiable, Equatable, Hashable, Codable, Sendable {
    public var id: String
    public var script: String
    public var message: String
    public var capturedAt: Date
    public var stack: String?
    /// Optional tool or notification channel that emitted the error. Lets the
    /// UI group failures by source ("notifications.tts.elevenlabs" vs
    /// "scripts.cleanup-tmux").
    public var source: String?
    /// Count of identical errors in the trailing window — failures-route
    /// already aggregates top_errors by fingerprint.
    public var occurrences: Int

    /// OpenTelemetry trace identifier for the row, when the error was
    /// captured under instrumentation. Nullable on legacy
    /// pre-instrumentation rows; the agent emits `null` in that case.
    /// Spec: agent-payload-completeness § Failure Top Errors Include
    /// Trace ID + Stack Truncation Marker.
    public var traceID: String?

    /// Whether the serialized `stack` exceeded the agent's truncation
    /// threshold (the agent caps stack length to keep payloads bounded).
    /// Non-optional in the model; older agents that omit the field decode
    /// as `false`.
    public var stackTruncated: Bool

    public enum CodingKeys: String, CodingKey {
        case id
        case script
        case message
        case capturedAt = "captured_at"
        case stack
        case source
        case occurrences
        case traceID = "trace_id"
        case stackTruncated = "stack_truncated"
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        self.id = (try? c.decode(String.self, forKey: .id))
            ?? UUID().uuidString
        self.script = (try? c.decode(String.self, forKey: .script)) ?? "(unknown)"
        self.message = (try? c.decode(String.self, forKey: .message)) ?? ""
        self.capturedAt = ScriptError.decodePermissiveDate(c, .capturedAt) ?? Date()
        self.stack = try? c.decode(String.self, forKey: .stack)
        self.source = try? c.decode(String.self, forKey: .source)
        self.occurrences = (try? c.decode(Int.self, forKey: .occurrences)) ?? 1
        // `trace_id` is genuinely nullable on legacy rows — `decodeIfPresent`
        // returns nil for absent OR explicit null.
        self.traceID = try c.decodeIfPresent(String.self, forKey: .traceID)
        // Backward-tolerant: older agents omit `stack_truncated`. Default
        // to false (untruncated).
        self.stackTruncated = try c.decodeIfPresent(Bool.self, forKey: .stackTruncated) ?? false
    }

    public init(
        id: String = UUID().uuidString,
        script: String,
        message: String,
        capturedAt: Date,
        stack: String? = nil,
        source: String? = nil,
        occurrences: Int = 1,
        traceID: String? = nil,
        stackTruncated: Bool = false
    ) {
        self.id = id
        self.script = script
        self.message = message
        self.capturedAt = capturedAt
        self.stack = stack
        self.source = source
        self.occurrences = occurrences
        self.traceID = traceID
        self.stackTruncated = stackTruncated
    }

    private static func decodePermissiveDate(
        _ c: KeyedDecodingContainer<CodingKeys>,
        _ key: CodingKeys
    ) -> Date? {
        if let s = try? c.decode(String.self, forKey: key) {
            let f1 = ISO8601DateFormatter()
            f1.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
            let f2 = ISO8601DateFormatter()
            f2.formatOptions = [.withInternetDateTime]
            return f1.date(from: s) ?? f2.date(from: s)
        }
        if let n = try? c.decode(Double.self, forKey: key) {
            return n > 1_000_000_000_000
                ? Date(timeIntervalSince1970: n / 1000)
                : Date(timeIntervalSince1970: n)
        }
        return nil
    }
}

/// Envelope for `GET /failures` — the aggregated failure summary plus the
/// flat `top_errors` array the dashboard consumes directly.
public struct FailuresResponse: Decodable, Sendable {
    public var periodDays: Int
    public var total: Int
    public var topErrors: [ScriptError]

    public enum CodingKeys: String, CodingKey {
        case periodDays = "period_days"
        case total
        case topErrors = "top_errors"
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        self.periodDays = (try? c.decode(Int.self, forKey: .periodDays)) ?? 7
        self.total = (try? c.decode(Int.self, forKey: .total)) ?? 0
        self.topErrors = (try? c.decode([ScriptError].self, forKey: .topErrors)) ?? []
    }
}
