/**
 * Notification delivery channels.
 *
 * `slack` was removed by `remove-slack-channel` (spine-migration). Macros /
 * persisted rules referencing it are silently dropped by the router's
 * "No handler for channel" path.
 */
export type NotificationChannel = "desktop" | "tts";

/** Notification priority levels. */
export type NotificationPriority = "low" | "normal" | "high";

/** Notification delivery status. */
export type NotificationStatus = "queued" | "delivered" | "expired";

/**
 * Dashboard-facing severity (agent-payload-completeness). Distinct from
 * `NotificationPriority` (delivery hint) — severity drives the Swift
 * dashboard's visual urgency surface.
 */
export type NotificationSeverity = "info" | "warn" | "error";

/**
 * Dashboard-facing delivery lifecycle (agent-payload-completeness).
 * Mirrors `NotificationStatus` but uses the Swift-facing enum spelling
 * the dashboard pins via PayloadDecodeTests v2.
 */
export type NotificationDeliveryState = "pending" | "delivered" | "failed";

/**
 * Wire shape returned by `GET /notifications` — what the Swift
 * `NotificationEvent` decoder reads. Distinct from the internal
 * `Notification` queue record below.
 */
export interface NotificationEvent {
  id: string;
  title: string;
  body: string;
  channel: NotificationChannel;
  project: string | null;
  severity: NotificationSeverity;
  delivery_state: NotificationDeliveryState;
  /** ISO-8601 string on the wire (matches `/sessions` convention). */
  created_at: string;
}

/** Meeting behavior when a notification arrives during an active meeting. */
export type MeetingBehavior = "buffer" | "drop" | "allow";

/** A notification queued or delivered by the agent. */
export interface Notification {
  id: string;
  channel: NotificationChannel;
  title: string;
  body: string;
  project?: string;
  priority: NotificationPriority;
  status: NotificationStatus;
  created_at: Date;
  sent_at?: Date;
}

/** Per-project routing rule for notification delivery. */
export interface NotificationRule {
  project?: string;
  channels: NotificationChannel[];
  meeting_behavior: MeetingBehavior;
}

/**
 * Wire shape returned by `GET /analytics/notifications`.
 *
 * Snake_case wire format matches DB column names so consumers (Swift
 * dashboard, TUI, scripts) consume one canonical shape — no per-client
 * renaming. Distinct from `NotificationEvent` (the live `/notifications`
 * list endpoint) because analytics surfaces additional bookkeeping
 * columns (`sent_at`, `priority`, `status`) and may grow time-window
 * aggregates over time.
 *
 * Spec: analytics-query-and-tts-synthesis, analytics-pagination-cursor
 */
export interface AnalyticsNotificationRow {
  id: string;
  channel: NotificationChannel;
  title: string;
  body: string;
  project: string | null;
  priority: NotificationPriority;
  status: NotificationStatus;
  severity: NotificationSeverity;
  delivery_state: NotificationDeliveryState;
  /** ISO-8601 string on the wire. */
  created_at: string;
  /** ISO-8601 string on the wire, or null if not yet sent. */
  sent_at: string | null;
  /**
   * ElevenLabs voice id that produced the cached audio (notifications-overhaul).
   * NULL when no synthesis happened (TTS disabled, synthesis failed, or row
   * predates the column).
   */
  voice_used: string | null;
  /**
   * True iff `audio_path` is set on the row AND the file currently exists on
   * disk. Derived per-request via `audioExists(id)` so pruned-but-pointer-
   * retained rows correctly report `false` (notifications-overhaul retention
   * sweep semantics).
   */
  audio_available: boolean;
}

/**
 * Wire envelope returned by `GET /analytics/notifications`
 * (analytics-pagination-cursor).
 *
 * Keyset pagination: `next_cursor` is an opaque base64url token encoding
 * `{created_at, id}`. Consumers MUST NOT parse it — pass it back verbatim
 * as `?cursor=...` on the next request. `has_more` mirrors "next_cursor is
 * non-null" but is surfaced explicitly so naive clients can branch on a
 * boolean instead of a null check.
 *
 * `filters` echoes the effective query so dashboards can render
 * "showing N over the last H hours for project=X" without re-parsing the
 * request URL. `hours` lives inside `filters` (top-level `hours` was
 * removed in analytics-pagination-cursor — Swift NetworkClient updated in
 * follow-up).
 */
export interface AnalyticsNotificationsResponse {
  rows: AnalyticsNotificationRow[];
  /** Opaque cursor for the next page; null when no more rows. */
  next_cursor: string | null;
  /** True when at least one more page exists. */
  has_more: boolean;
  /** Number of rows in this response (always <= effective limit). */
  count: number;
  /** Echo of the effective filter shape used for this query. */
  filters: {
    hours: number;
    project: string | null;
    status: string | null;
  };
}
