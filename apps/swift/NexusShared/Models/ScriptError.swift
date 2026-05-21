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

    /// Project slug emitted by the failures-investigation-and-surface
    /// JSONL-aggregate pipeline. Optional for back-compat with the
    /// notification-failures unified feed which doesn't carry it.
    public var project: String?

    /// Command snippet captured at failure time (the failing tool input).
    /// Optional — only the JSONL-sourced aggregate populates this.
    public var command: String?

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
        case project
        case command
    }

    /// Secondary input-only key. Wire payloads from the JSONL-aggregate
    /// pipeline emit `tool` alongside `script`; the decoder reads either.
    /// Kept out of `CodingKeys` so auto-synthesized Encodable still works.
    private enum InputAliasKeys: String, CodingKey {
        case tool
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        self.id = (try? c.decode(String.self, forKey: .id))
            ?? UUID().uuidString
        // Prefer the agent's `script` field, but fall back to `tool` for the
        // failures-investigation-and-surface JSONL-aggregate pipeline which
        // emits `tool` as the canonical name.
        var scriptValue = try? c.decode(String.self, forKey: .script)
        if scriptValue == nil {
            let aliasContainer = try? decoder.container(keyedBy: InputAliasKeys.self)
            scriptValue = try? aliasContainer?.decode(String.self, forKey: .tool)
        }
        self.script = scriptValue ?? "(unknown)"
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
        self.project = try? c.decodeIfPresent(String.self, forKey: .project)
        self.command = try? c.decodeIfPresent(String.self, forKey: .command)
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
        stackTruncated: Bool = false,
        project: String? = nil,
        command: String? = nil
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
        self.project = project
        self.command = command
    }

    /// Convenience: the tool name this failure represents. Mirrors `script`
    /// for back-compat with the existing rendering code.
    public var tool: String { script }

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

/// Trend summary for the `GET /failures` envelope — current-vs-previous
/// window comparison. Direction is `"up" | "down" | "flat"`.
///
/// Spec: openspec/changes/failures-investigation-and-surface (task 1.8)
public struct FailureTrend: Decodable, Sendable, Equatable {
    public var current: Int
    public var previous: Int
    public var direction: String

    public init(current: Int = 0, previous: Int = 0, direction: String = "flat") {
        self.current = current
        self.previous = previous
        self.direction = direction
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        self.current = (try? c.decode(Int.self, forKey: .current)) ?? 0
        self.previous = (try? c.decode(Int.self, forKey: .previous)) ?? 0
        self.direction = (try? c.decode(String.self, forKey: .direction)) ?? "flat"
    }

    enum CodingKeys: String, CodingKey {
        case current
        case previous
        case direction
    }
}

/// Envelope for `GET /failures` — the aggregated failure summary plus the
/// flat `top_errors` array the dashboard consumes directly.
///
/// Extended by failures-investigation-and-surface (task 1.8):
/// - `byTool` / `byProject`: count maps for the filter-chip strip
/// - `trend`: current-vs-previous indicator for the header
/// - `source`: provenance label (`"jsonl"`) — optional for back-compat
/// - `parseErrors`: malformed-line count — optional for back-compat
public struct FailuresResponse: Decodable, Sendable {
    public var periodDays: Int
    public var total: Int
    public var topErrors: [ScriptError]
    public var byTool: [String: Int]
    public var byProject: [String: Int]
    public var trend: FailureTrend
    /// Provenance label naming the active data source. `nil` decodes from
    /// older agents that pre-date the field.
    public var source: String?
    /// Count of malformed JSONL lines skipped during ingest. `nil` from
    /// older agents that don't surface the counter.
    public var parseErrors: Int?

    public enum CodingKeys: String, CodingKey {
        case periodDays = "period_days"
        case total
        case topErrors = "top_errors"
        case byTool = "by_tool"
        case byProject = "by_project"
        case trend
        case source
        case parseErrors = "parse_errors"
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        self.periodDays = (try? c.decode(Int.self, forKey: .periodDays)) ?? 7
        self.total = (try? c.decode(Int.self, forKey: .total)) ?? 0
        self.topErrors = (try? c.decode([ScriptError].self, forKey: .topErrors)) ?? []
        self.byTool = (try? c.decode([String: Int].self, forKey: .byTool)) ?? [:]
        self.byProject = (try? c.decode([String: Int].self, forKey: .byProject)) ?? [:]
        self.trend = (try? c.decode(FailureTrend.self, forKey: .trend)) ?? FailureTrend()
        self.source = try? c.decodeIfPresent(String.self, forKey: .source)
        self.parseErrors = try? c.decodeIfPresent(Int.self, forKey: .parseErrors)
    }

    /// Direct initializer for ViewModel-side testing seams.
    public init(
        periodDays: Int = 7,
        total: Int = 0,
        topErrors: [ScriptError] = [],
        byTool: [String: Int] = [:],
        byProject: [String: Int] = [:],
        trend: FailureTrend = FailureTrend(),
        source: String? = nil,
        parseErrors: Int? = nil
    ) {
        self.periodDays = periodDays
        self.total = total
        self.topErrors = topErrors
        self.byTool = byTool
        self.byProject = byProject
        self.trend = trend
        self.source = source
        self.parseErrors = parseErrors
    }
}
