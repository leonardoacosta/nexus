/**
 * Notification settings route handlers.
 *
 * Backs the `/notifications/settings` GET / PATCH endpoints introduced by the
 * `add-notification-control-dashboard` proposal. The settings table is
 * single-row by design (id = 1, bootstrapped by the migration) — both
 * handlers operate on that one row.
 *
 * Auth note: the legacy `requiresAuth` flag and `notifications-builder.ts`
 * were removed by `apply-4-findings`. Reach is now constrained at the bind
 * layer (loopback + Tailscale only); handlers therefore do not call
 * `requireSecret` directly — same convention as the sibling `settings.ts` /
 * `notifications.ts` modules.
 *
 * On a successful PATCH the post-update row is broadcast via
 * `lifecycleBus.emit("SettingsChanged", …)` so SSE subscribers (the Mac
 * listener) can update their cached toggles without polling.
 */

import type { Db } from "@nexus/db";
import { notificationSettings, routingRules, eq } from "@nexus/db";
import { lifecycleBus } from "../services/lifecycle-bus";
import { DEFAULT_PRESENCE_USER } from "../notifications/presence-context";

// ── Constants ────────────────────────────────────────────────────────────────

const SETTINGS_ROW_ID = 1;
// context-aware-routing adds three presence-routing keys to the allow-list.
const ALLOWED_KEYS = new Set([
  "tts_enabled",
  "banner_enabled",
  "ducking_mode",
  "presence_aware_routing",
  "unknown_noncritical_mode",
  "unknown_critical_mode",
  // ios-presence-reporter (Phase 2): the bedtime-source policy.
  "bedtime_sources",
  // Rate-throttle for repeat TTS notifications (noise-reduction audit,
  // 2026-07-13, plan 041).
  "rate_throttle_enabled",
  "rate_throttle_max_per_window",
  "rate_throttle_window_minutes",
  // Wall-clock quiet-hours gate (noise-reduction audit, 2026-07-13, plan 042).
  "quiet_hours_enabled",
  "quiet_hours_start_hour",
  "quiet_hours_end_hour",
]);
const DUCKING_MODES = new Set(["full", "half", "mute"]);
const FAIL_MODES = new Set(["fail-safe", "fail-open"]);
const BEDTIME_SOURCES = new Set(["hk", "focus", "either", "both"]);

type DuckingMode = "full" | "half" | "mute";
type FailMode = "fail-safe" | "fail-open";
type BedtimeSources = "hk" | "focus" | "either" | "both";

interface SettingsResponse {
  id: number;
  tts_enabled: boolean;
  banner_enabled: boolean;
  ducking_mode: DuckingMode;
  presence_aware_routing: boolean;
  unknown_noncritical_mode: FailMode;
  unknown_critical_mode: FailMode;
  bedtime_sources: BedtimeSources;
  rate_throttle_enabled: boolean;
  rate_throttle_max_per_window: number;
  rate_throttle_window_minutes: number;
  quiet_hours_enabled: boolean;
  quiet_hours_start_hour: number;
  quiet_hours_end_hour: number;
  updated_at: string;
}

interface SettingsRow {
  id: number;
  ttsEnabled: boolean;
  bannerEnabled: boolean;
  duckingMode: DuckingMode;
  presenceAwareRouting: boolean;
  unknownNoncriticalMode: FailMode;
  unknownCriticalMode: FailMode;
  bedtimeSources: BedtimeSources;
  rateThrottleEnabled: boolean;
  rateThrottleMaxPerWindow: number;
  rateThrottleWindowMinutes: number;
  quietHoursEnabled: boolean;
  quietHoursStartHour: number;
  quietHoursEndHour: number;
  updatedAt: Date;
}

/**
 * Map an internal Drizzle row (camelCase) to the wire format (snake_case).
 *
 * The wire format mirrors the DB column names exactly so the Mac listener
 * (bash) and the Next.js dashboard (TS) both consume a single canonical
 * shape — no per-client renaming.
 */
function toResponse(row: SettingsRow): SettingsResponse {
  return {
    id: row.id,
    tts_enabled: row.ttsEnabled,
    banner_enabled: row.bannerEnabled,
    ducking_mode: row.duckingMode,
    presence_aware_routing: row.presenceAwareRouting,
    unknown_noncritical_mode: row.unknownNoncriticalMode,
    unknown_critical_mode: row.unknownCriticalMode,
    bedtime_sources: row.bedtimeSources,
    rate_throttle_enabled: row.rateThrottleEnabled,
    rate_throttle_max_per_window: row.rateThrottleMaxPerWindow,
    rate_throttle_window_minutes: row.rateThrottleWindowMinutes,
    quiet_hours_enabled: row.quietHoursEnabled,
    quiet_hours_start_hour: row.quietHoursStartHour,
    quiet_hours_end_hour: row.quietHoursEndHour,
    updated_at: row.updatedAt.toISOString(),
  };
}

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

// ── GET /notifications/settings ──────────────────────────────────────────────

/**
 * Return the single-row settings record (id = 1).
 *
 * If the bootstrap row is missing for any reason (manual DB tampering,
 * test schema without the seed), respond 404 — the Mac listener already
 * has a hardcoded fallback (`tts=true, banner=true, ducking=full`) per the
 * proposal's rollback note, so this is safe.
 */
export async function handleGetNotificationSettings(
  db: Db,
  _request: Request,
): Promise<Response> {
  const row = await db.query.notificationSettings.findFirst({
    where: eq(notificationSettings.id, SETTINGS_ROW_ID),
  });

  if (!row) {
    return jsonResponse(
      { error: "settings row not found", detail: "id=1 sentinel missing" },
      404,
    );
  }

  return jsonResponse(toResponse(row));
}

// ── PATCH /notifications/settings ────────────────────────────────────────────

/**
 * Patch the single-row settings record and emit `SettingsChanged`.
 *
 * Validation rules:
 * - Body MUST be a JSON object (not array, not null, not primitive).
 * - Every top-level key MUST be in the allow-list
 *   (`tts_enabled`, `banner_enabled`, `ducking_mode`).
 * - `tts_enabled` / `banner_enabled` MUST be boolean when present.
 * - `ducking_mode` MUST be one of `"full" | "half" | "mute"` when present.
 * - Empty body `{}` is allowed (no-op update; still bumps `updated_at`).
 *
 * On success the handler:
 * 1. UPDATEs row id=1 with the partial patch + `updatedAt = now()`.
 * 2. Reads back the full row (via `.returning()`).
 * 3. Emits `lifecycleBus.emit("SettingsChanged", { ttsEnabled, bannerEnabled, duckingMode })`.
 * 4. Returns the refreshed row in wire format.
 */
export async function handlePatchNotificationSettings(
  db: Db,
  request: Request,
): Promise<Response> {
  // ── Parse JSON ──────────────────────────────────────────────────────────
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return jsonResponse({ error: "invalid JSON body" }, 400);
  }

  if (
    body === null ||
    typeof body !== "object" ||
    Array.isArray(body)
  ) {
    return jsonResponse(
      { error: "body must be a JSON object" },
      400,
    );
  }

  const patch = body as Record<string, unknown>;

  // ── Allow-list validation ──────────────────────────────────────────────
  for (const key of Object.keys(patch)) {
    if (!ALLOWED_KEYS.has(key)) {
      return jsonResponse(
        {
          error: "unknown field",
          detail: `"${key}" is not one of: ${[...ALLOWED_KEYS].join(", ")}`,
        },
        400,
      );
    }
  }

  // ── Per-field type validation ──────────────────────────────────────────
  const update: Partial<{
    ttsEnabled: boolean;
    bannerEnabled: boolean;
    duckingMode: DuckingMode;
    presenceAwareRouting: boolean;
    unknownNoncriticalMode: FailMode;
    unknownCriticalMode: FailMode;
    bedtimeSources: BedtimeSources;
    rateThrottleEnabled: boolean;
    rateThrottleMaxPerWindow: number;
    rateThrottleWindowMinutes: number;
    quietHoursEnabled: boolean;
    quietHoursStartHour: number;
    quietHoursEndHour: number;
  }> = {};

  if ("tts_enabled" in patch) {
    if (typeof patch.tts_enabled !== "boolean") {
      return jsonResponse(
        { error: "tts_enabled must be a boolean" },
        400,
      );
    }
    update.ttsEnabled = patch.tts_enabled;
  }

  if ("banner_enabled" in patch) {
    if (typeof patch.banner_enabled !== "boolean") {
      return jsonResponse(
        { error: "banner_enabled must be a boolean" },
        400,
      );
    }
    update.bannerEnabled = patch.banner_enabled;
  }

  if ("ducking_mode" in patch) {
    const dm = patch.ducking_mode;
    if (typeof dm !== "string" || !DUCKING_MODES.has(dm)) {
      return jsonResponse(
        {
          error: "ducking_mode must be one of: full, half, mute",
        },
        400,
      );
    }
    update.duckingMode = dm as DuckingMode;
  }

  if ("presence_aware_routing" in patch) {
    if (typeof patch.presence_aware_routing !== "boolean") {
      return jsonResponse(
        { error: "presence_aware_routing must be a boolean" },
        400,
      );
    }
    update.presenceAwareRouting = patch.presence_aware_routing;
  }

  if ("unknown_noncritical_mode" in patch) {
    const m = patch.unknown_noncritical_mode;
    if (typeof m !== "string" || !FAIL_MODES.has(m)) {
      return jsonResponse(
        { error: "unknown_noncritical_mode must be one of: fail-safe, fail-open" },
        400,
      );
    }
    update.unknownNoncriticalMode = m as FailMode;
  }

  if ("unknown_critical_mode" in patch) {
    const m = patch.unknown_critical_mode;
    if (typeof m !== "string" || !FAIL_MODES.has(m)) {
      return jsonResponse(
        { error: "unknown_critical_mode must be one of: fail-safe, fail-open" },
        400,
      );
    }
    update.unknownCriticalMode = m as FailMode;
  }

  if ("bedtime_sources" in patch) {
    const m = patch.bedtime_sources;
    if (typeof m !== "string" || !BEDTIME_SOURCES.has(m)) {
      return jsonResponse(
        { error: "bedtime_sources must be one of: hk, focus, either, both" },
        400,
      );
    }
    update.bedtimeSources = m as BedtimeSources;
  }

  if ("rate_throttle_enabled" in patch) {
    if (typeof patch.rate_throttle_enabled !== "boolean") {
      return jsonResponse({ error: "rate_throttle_enabled must be a boolean" }, 400);
    }
    update.rateThrottleEnabled = patch.rate_throttle_enabled;
  }

  if ("rate_throttle_max_per_window" in patch) {
    const v = patch.rate_throttle_max_per_window;
    if (typeof v !== "number" || !Number.isInteger(v) || v <= 0) {
      return jsonResponse(
        { error: "rate_throttle_max_per_window must be a positive integer" },
        400,
      );
    }
    update.rateThrottleMaxPerWindow = v;
  }

  if ("rate_throttle_window_minutes" in patch) {
    const v = patch.rate_throttle_window_minutes;
    if (typeof v !== "number" || !Number.isInteger(v) || v <= 0) {
      return jsonResponse(
        { error: "rate_throttle_window_minutes must be a positive integer" },
        400,
      );
    }
    update.rateThrottleWindowMinutes = v;
  }

  if ("quiet_hours_enabled" in patch) {
    if (typeof patch.quiet_hours_enabled !== "boolean") {
      return jsonResponse({ error: "quiet_hours_enabled must be a boolean" }, 400);
    }
    update.quietHoursEnabled = patch.quiet_hours_enabled;
  }

  if ("quiet_hours_start_hour" in patch) {
    const v = patch.quiet_hours_start_hour;
    if (typeof v !== "number" || !Number.isInteger(v) || v < 0 || v > 23) {
      return jsonResponse(
        { error: "quiet_hours_start_hour must be an integer between 0 and 23" },
        400,
      );
    }
    update.quietHoursStartHour = v;
  }

  if ("quiet_hours_end_hour" in patch) {
    const v = patch.quiet_hours_end_hour;
    if (typeof v !== "number" || !Number.isInteger(v) || v < 0 || v > 23) {
      return jsonResponse(
        { error: "quiet_hours_end_hour must be an integer between 0 and 23" },
        400,
      );
    }
    update.quietHoursEndHour = v;
  }

  // ── No-op short-circuit (analytics-query-and-tts-synthesis) ─────────────
  // SELECT the current row, merge the candidate patch, and if every field
  // matches the existing value, return 200 WITHOUT issuing an UPDATE and
  // WITHOUT emitting SettingsChanged. The spec scenario "no-op MUST NOT
  // broadcast" was failing because the previous code always bumped
  // updated_at — now PATCH {} (or PATCH {tts_enabled: true} when it was
  // already true) is truly idempotent.
  const current = await db.query.notificationSettings.findFirst({
    where: eq(notificationSettings.id, SETTINGS_ROW_ID),
  });
  if (!current) {
    return jsonResponse(
      { error: "settings row not found", detail: "id=1 sentinel missing" },
      404,
    );
  }

  const changed =
    (update.ttsEnabled !== undefined && update.ttsEnabled !== current.ttsEnabled) ||
    (update.bannerEnabled !== undefined && update.bannerEnabled !== current.bannerEnabled) ||
    (update.duckingMode !== undefined && update.duckingMode !== current.duckingMode) ||
    (update.presenceAwareRouting !== undefined &&
      update.presenceAwareRouting !== current.presenceAwareRouting) ||
    (update.unknownNoncriticalMode !== undefined &&
      update.unknownNoncriticalMode !== current.unknownNoncriticalMode) ||
    (update.unknownCriticalMode !== undefined &&
      update.unknownCriticalMode !== current.unknownCriticalMode) ||
    (update.bedtimeSources !== undefined &&
      update.bedtimeSources !== current.bedtimeSources) ||
    (update.rateThrottleEnabled !== undefined &&
      update.rateThrottleEnabled !== current.rateThrottleEnabled) ||
    (update.rateThrottleMaxPerWindow !== undefined &&
      update.rateThrottleMaxPerWindow !== current.rateThrottleMaxPerWindow) ||
    (update.rateThrottleWindowMinutes !== undefined &&
      update.rateThrottleWindowMinutes !== current.rateThrottleWindowMinutes) ||
    (update.quietHoursEnabled !== undefined &&
      update.quietHoursEnabled !== current.quietHoursEnabled) ||
    (update.quietHoursStartHour !== undefined &&
      update.quietHoursStartHour !== current.quietHoursStartHour) ||
    (update.quietHoursEndHour !== undefined &&
      update.quietHoursEndHour !== current.quietHoursEndHour);

  if (!changed) {
    // No-op: return current row, do NOT UPDATE, do NOT emit.
    return jsonResponse(toResponse(current));
  }

  // ── Persist ────────────────────────────────────────────────────────────
  const updated = await db
    .update(notificationSettings)
    .set({ ...update, updatedAt: new Date() })
    .where(eq(notificationSettings.id, SETTINGS_ROW_ID))
    .returning();

  const row = updated[0];
  if (!row) {
    return jsonResponse(
      { error: "settings row not found", detail: "id=1 sentinel missing" },
      404,
    );
  }

  // ── Broadcast ──────────────────────────────────────────────────────────
  lifecycleBus.emit("SettingsChanged", {
    ttsEnabled: row.ttsEnabled,
    bannerEnabled: row.bannerEnabled,
    duckingMode: row.duckingMode,
  });

  return jsonResponse(toResponse(row));
}

// ── /notifications/routing-rules — ordered routing-rule CRUD ──────────────
//
// context-aware-routing (Phase 1). The rules engine reads these in `priority`
// order (first-match-wins). The wire contract is an ARRAY whose index IS the
// priority — the client sends rules in the order it wants them evaluated and
// the handler stamps `priority = index`, so a drag-reorder is just a re-PUT in
// the new order. A PUT REPLACES the whole set (delete-then-insert) so reorders
// and deletions are expressed atomically without per-row diffing.

interface RoutingRuleWire {
  id: string;
  priority: number;
  condition: Record<string, unknown>;
  action: Record<string, unknown>;
  enabled: boolean;
}

function ruleToWire(row: {
  id: string;
  priority: number;
  condition: Record<string, unknown>;
  action: Record<string, unknown>;
  enabled: boolean;
}): RoutingRuleWire {
  return {
    id: row.id,
    priority: row.priority,
    condition: row.condition,
    action: row.action,
    enabled: row.enabled,
  };
}

/** GET /notifications/routing-rules — return the rules ordered by priority. */
export async function handleGetRoutingRules(db: Db): Promise<Response> {
  const rows = await db
    .select()
    .from(routingRules)
    .where(eq(routingRules.userId, DEFAULT_PRESENCE_USER))
    .orderBy(routingRules.priority);

  return jsonResponse({ rules: rows.map(ruleToWire) });
}

/**
 * PUT /notifications/routing-rules — replace the rule set.
 *
 * Body: `{ rules: Array<{ id, condition, action, enabled }> }`. The array index
 * becomes the persisted `priority`. The whole set is replaced (delete-all +
 * insert) so a reorder is a single atomic PUT. Broadcasts `SettingsChanged` so
 * SSE subscribers re-read without polling.
 */
export async function handlePutRoutingRules(
  db: Db,
  request: Request,
): Promise<Response> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return jsonResponse({ error: "invalid JSON body" }, 400);
  }

  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    return jsonResponse({ error: "body must be a JSON object" }, 400);
  }

  const rules = (body as Record<string, unknown>).rules;
  if (!Array.isArray(rules)) {
    return jsonResponse({ error: "rules must be an array" }, 400);
  }

  // Validate + project each incoming rule before touching the DB.
  const toInsert: {
    id: string;
    userId: string;
    priority: number;
    condition: Record<string, unknown>;
    action: Record<string, unknown>;
    enabled: boolean;
  }[] = [];

  for (const [i, raw] of rules.entries()) {
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
      return jsonResponse(
        { error: "each rule must be an object", detail: `index ${i}` },
        400,
      );
    }
    const r = raw as Record<string, unknown>;
    if (typeof r.id !== "string" || r.id.length === 0) {
      return jsonResponse(
        { error: "each rule needs a non-empty string id", detail: `index ${i}` },
        400,
      );
    }
    if (r.condition !== undefined && (typeof r.condition !== "object" || r.condition === null)) {
      return jsonResponse(
        { error: "rule.condition must be an object", detail: `index ${i}` },
        400,
      );
    }
    if (r.action !== undefined && (typeof r.action !== "object" || r.action === null)) {
      return jsonResponse(
        { error: "rule.action must be an object", detail: `index ${i}` },
        400,
      );
    }
    toInsert.push({
      id: r.id,
      userId: DEFAULT_PRESENCE_USER,
      priority: i, // index IS the priority — first-match-wins, top to bottom.
      condition: (r.condition as Record<string, unknown>) ?? {},
      action: (r.action as Record<string, unknown>) ?? {},
      enabled: typeof r.enabled === "boolean" ? r.enabled : true,
    });
  }

  // Replace the whole set: delete-all then insert in submission order.
  await db.delete(routingRules).where(eq(routingRules.userId, DEFAULT_PRESENCE_USER));
  if (toInsert.length > 0) {
    await db.insert(routingRules).values(toInsert);
  }

  // Broadcast settings change so clients re-read the rules. Reuse the existing
  // SettingsChanged event — no new SSE channel (design decision). We read the
  // current settings row to populate the payload; if it's missing we still
  // emit with the column defaults so subscribers refresh.
  const settings = await db.query.notificationSettings.findFirst({
    where: eq(notificationSettings.id, SETTINGS_ROW_ID),
  });
  lifecycleBus.emit("SettingsChanged", {
    ttsEnabled: settings?.ttsEnabled ?? true,
    bannerEnabled: settings?.bannerEnabled ?? true,
    duckingMode: settings?.duckingMode ?? "full",
  });

  return jsonResponse({ rules: toInsert.map(ruleToWire) });
}
