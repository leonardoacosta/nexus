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

    /// Optional bullet items emitted by structured-summary jobs (currently
    /// the weekly reaper completion notification — bloat findings list).
    /// Mac renderer expands these into a `• line` body when non-empty.
    /// Spec: openspec/changes/adopt-reaper-into-nx-cron (task 3.1, wire
    /// contract from API task 2.8 in `apps/agent/src/services/lifecycle-bus.ts`).
    /// Codable back-compat: older payloads omit the key and decode as nil.
    public var items: [String]?

    /// Optional path to a job log file. When present, clicking the banner
    /// activates `NSWorkspace.shared.open(URL(fileURLWithPath: logPath))`
    /// instead of the default click-attribution path. Threaded from the
    /// agent's reaper job completion payload (API task 2.8).
    /// Codable back-compat: older payloads omit the key and decode as nil.
    public var logPath: String?

    /// Optional URL to open on banner click via NSWorkspace.shared.open.
    /// Threaded from the agent's `url` field (mopen / iopen command).
    /// Codable back-compat: older payloads omit the key and decode as nil.
    public var url: String?

    /// True when the agent has a cached MP3 for this notification on
    /// disk (notifications-overhaul, task 2.10). Optional in the wire
    /// contract — older agents omit the key and the field decodes as
    /// `nil` (rendered identically to `false` by the dashboard).
    public var audioAvailable: Bool?

    /// Voice id that produced the cached MP3 (notifications-overhaul,
    /// task 2.10). Useful for debugging per-project voice resolution.
    /// Optional + back-compat — `nil` when synthesis didn't happen or
    /// the row predates the column.
    public var voiceUsed: String?

    /// Custom session name (CC `/rename` title, persisted as `customTitle`
    /// in the transcript jsonl) threaded through the notification pipeline
    /// (nx-20caf). Optional in the wire contract — older agents omit the
    /// key and the field decodes as `nil`. When present, the banner names
    /// the session (subtitle) and the Session sort/group keys on it instead
    /// of the channel proxy.
    public var sessionName: String?

    /// Banner / list display title. Mirrors the agent's
    /// `composeTitle(project, session, fallback)` rule (notification-fidelity
    /// API batch, `apps/agent/src/health-push/notification-push.ts`): both
    /// `project` and `sessionName` present (trimmed non-empty) ->
    /// `"\(project) · \(sessionName)"` (MIDDOT U+00B7, spaces around it);
    /// else `sessionName`, else `project`, else `title`, else `"Nexus"`.
    /// MUST stay in lockstep with the bun `composeTitle` test (task 1.3).
    public var displayTitle: String {
        let p = (project ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        let s = (sessionName ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        if !p.isEmpty, !s.isEmpty {
            return "\(p) · \(s)"
        }
        if !s.isEmpty { return s }
        if !p.isEmpty { return p }
        let t = (title ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        if !t.isEmpty { return t }
        return "Nexus"
    }

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
        // adopt-reaper-into-nx-cron (task 3.1): optional structured fields
        // forwarded from `NotificationFiredPayload`. Snake-case `log_path`
        // matches the canonical agent wire spelling; camelCase fallback is
        // accepted as a tolerance hook (some legacy SSE frames camelCase).
        case items
        case logPath = "log_path"
        case logPathCamel = "logPath"
        // mopen / iopen: optional URL to open on banner click. The agent
        // emits the key literally as `url`.
        case url
        // notifications-overhaul (task 3.1): audio cache liveness flag
        // and the voice id that produced the cached MP3. Both optional
        // for back-compat with pre-overhaul agents.
        case audioAvailable
        case voiceUsed
        // nx-20caf: optional custom session name (camelCase, mirrors
        // logPath/audioBase64 spelling). Absent on older agents.
        case sessionName
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
        deliveryState: DeliveryState = .pending,
        items: [String]? = nil,
        logPath: String? = nil,
        url: String? = nil,
        audioAvailable: Bool? = nil,
        voiceUsed: String? = nil,
        sessionName: String? = nil
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
        self.items = items
        self.logPath = logPath
        self.url = url
        self.audioAvailable = audioAvailable
        self.voiceUsed = voiceUsed
        self.sessionName = sessionName
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

        // adopt-reaper-into-nx-cron task 3.1: optional structured fields.
        // Absent keys decode as nil — back-compat for older agent payloads
        // and non-reaper notifications. `items` is strict on shape (must
        // be a JSON string array if present); `logPath` accepts either
        // snake_case (canonical) or camelCase (legacy SSE tolerance).
        self.items = try c.decodeIfPresent([String].self, forKey: .items)
        if let snake = try c.decodeIfPresent(String.self, forKey: .logPath) {
            self.logPath = snake
        } else if let camel = try c.decodeIfPresent(String.self, forKey: .logPathCamel) {
            self.logPath = camel
        } else {
            self.logPath = nil
        }
        self.url = try c.decodeIfPresent(String.self, forKey: .url)

        // notifications-overhaul (task 3.1): optional. Absent keys decode
        // as nil — back-compat with pre-overhaul agents.
        self.audioAvailable = try c.decodeIfPresent(Bool.self, forKey: .audioAvailable)
        self.voiceUsed = try c.decodeIfPresent(String.self, forKey: .voiceUsed)

        // nx-20caf: optional custom session name. Absent keys decode as nil
        // — back-compat with agents that predate the customTitle wire-up.
        self.sessionName = try c.decodeIfPresent(String.self, forKey: .sessionName)
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
        // Round-trip the optional structured fields on the canonical
        // snake-case key. We do NOT emit the camelCase `logPath` legacy
        // spelling — decode tolerates it, encode is contract.
        try c.encodeIfPresent(items, forKey: .items)
        try c.encodeIfPresent(logPath, forKey: .logPath)
        try c.encodeIfPresent(url, forKey: .url)
        // notifications-overhaul (task 3.1): round-trip on the same key.
        try c.encodeIfPresent(audioAvailable, forKey: .audioAvailable)
        try c.encodeIfPresent(voiceUsed, forKey: .voiceUsed)
        // nx-20caf: round-trip on the canonical camelCase key.
        try c.encodeIfPresent(sessionName, forKey: .sessionName)
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
