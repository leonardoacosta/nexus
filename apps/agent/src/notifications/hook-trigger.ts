/**
 * Hook event → notification trigger orchestrator.
 *
 * Wraps the pure rule registry in `hook-rules.ts` with the impure pieces
 * needed at dispatch time: a per-rule suppression cache, a read of the
 * single-row `notification_settings` table, and the `NotificationManager.send()`
 * call. Lives outside the rule bodies so rules stay unit-testable without a
 * database or HTTP context.
 *
 * Suppression policy (from spec, mirroring the cc-side throttle convention):
 *
 *   tool_use_fail        : key = `tool_use_fail:<tool_name>`     window = 30s
 *   permission_request   : no suppression (always fires)
 *   hook_failure         : key = `hook_failure:<hook_name>`      window = 30s
 *   session_stop crash   : key = `session_stop:<session_id>`     window = 30s
 *   session_summary      : key = `session_summary:<session_id>`  window = 30s
 *   api_error            : key = `api_error:<session_id>`        window = 30s
 *
 * The spec describes session_stop / session_summary suppression as "per
 * session (effectively infinite)". We use the same 30s window for all keys —
 * consistent semantics, simple eviction, and a duplicate session_stop arriving
 * 31s later (vanishingly rare) would still benefit from re-notifying the user.
 *
 * Settings filter (from spec):
 *   - tts_enabled === false   → strip "tts" from dispatch
 *   - banner_enabled === false → strip "desktop" from dispatch
 *   - slack always passes (no per-channel toggle in v1)
 *   - settings row missing    → failsafe to all-enabled (surface, don't swallow)
 */

import { randomUUID } from "node:crypto";
import type { Db } from "@nexus/db";
import { notificationSettings } from "@nexus/db";
import { eq } from "drizzle-orm";
import { createLogger } from "@nexus/core/node";
import type { NotificationChannel } from "@nexus/core";

import type { HookEventPayload } from "../routes/hooks-types";
import { hookRules, type NotificationDraft } from "./hook-rules";
import type { NotificationManager } from "./manager";

const log = createLogger("agent:notifications:hook-trigger");

const SETTINGS_ROW_ID = 1;
/** Suppression window applied to all rules with a non-null suppression key. */
export const SUPPRESSION_WINDOW_MS = 30_000;

/** Module-private suppression cache: key → lastFireMs (epoch). */
const suppressionCache = new Map<string, number>();

/** Build the suppression key for an event, or `null` to opt out of suppression. */
function suppressionKey(
  eventType: string,
  payload: HookEventPayload,
): string | null {
  switch (eventType) {
    case "tool_use_fail":
      return `tool_use_fail:${payload.tool_name ?? payload.tool ?? "unknown"}`;
    case "hook_failure":
      return `hook_failure:${payload.hook_name ?? payload.handler ?? "unknown"}`;
    case "session_stop":
      return `session_stop:${payload.session_id ?? "unknown"}`;
    case "session_summary":
      return `session_summary:${payload.session_id ?? "unknown"}`;
    case "api_error":
      // Per-session key (add-api-error-notification, nx-avasg). A multi-minute
      // 529 outage emits many api-error lines on one session; the 30s window
      // collapses them to one delivered notification. Concurrent sessions key
      // independently so each alerts once.
      return `api_error:${payload.session_id ?? "unknown"}`;
    case "permission_request":
      return null; // never suppress — always fire
    default:
      return null;
  }
}

interface SettingsSnapshot {
  ttsEnabled: boolean;
  bannerEnabled: boolean;
}

/**
 * Read the single-row `notification_settings` record. Returns the all-enabled
 * default when the row is missing or the read throws — the spec mandates
 * fail-open so that an unconfigured deploy still surfaces notifications.
 */
async function readSettings(db: Db): Promise<SettingsSnapshot> {
  try {
    const row = await db.query.notificationSettings.findFirst({
      where: eq(notificationSettings.id, SETTINGS_ROW_ID),
    });
    if (!row) {
      // Failsafe: surface notifications when the bootstrap row is missing.
      return { ttsEnabled: true, bannerEnabled: true };
    }
    return { ttsEnabled: row.ttsEnabled, bannerEnabled: row.bannerEnabled };
  } catch (err) {
    log.warn({ err }, "notification_settings read failed — defaulting to all-enabled");
    return { ttsEnabled: true, bannerEnabled: true };
  }
}

/** Apply the settings filter to a rule's drafts. Returns the surviving subset. */
function filterByChannelSettings(
  drafts: NotificationDraft[],
  settings: SettingsSnapshot,
): NotificationDraft[] {
  return drafts.filter((d) => {
    if (d.channel === "tts" && !settings.ttsEnabled) return false;
    if (d.channel === "desktop" && !settings.bannerEnabled) return false;
    return true; // slack always passes
  });
}

/**
 * Evaluate the rule for `eventType`, apply suppression + settings filtering,
 * and dispatch surviving drafts via `manager.send()`.
 *
 * Contract: this function NEVER throws. Internal failures are logged via the
 * structured logger so the upstream `handleHooks` route stays a thin try/catch
 * (the hook handler MUST return 200 even when notification dispatch fails —
 * cc events are fire-and-forget).
 */
export async function evaluateAndDispatch(
  db: Db,
  manager: NotificationManager,
  eventType: string,
  payload: HookEventPayload,
): Promise<void> {
  const rule = hookRules[eventType];
  if (!rule) return; // event type has no notification rule — silent no-op

  let drafts: NotificationDraft[] | null;
  try {
    drafts = rule(payload);
  } catch (err) {
    log.warn({ err, eventType }, "hook rule threw — skipping dispatch");
    return;
  }
  if (!drafts || drafts.length === 0) return;

  // ─── Suppression ────────────────────────────────────────────────────────
  const key = suppressionKey(eventType, payload);
  if (key !== null) {
    const last = suppressionCache.get(key);
    const now = Date.now();
    if (last !== undefined && now - last < SUPPRESSION_WINDOW_MS) {
      log.info({ eventType, key }, "trigger suppressed");
      return;
    }
    suppressionCache.set(key, now);
  }

  // ─── Settings filter ────────────────────────────────────────────────────
  const settings = await readSettings(db);
  const filtered = filterByChannelSettings(drafts, settings);
  if (filtered.length === 0) {
    log.info(
      { eventType, ttsEnabled: settings.ttsEnabled, bannerEnabled: settings.bannerEnabled },
      "all channels filtered out — skipping send",
    );
    return;
  }

  // ─── Dispatch ───────────────────────────────────────────────────────────
  // One row per channel — mirrors the manager's existing single-channel
  // delivery model. Per-row failures are isolated (Promise.allSettled).
  const sends = filtered.map((draft) =>
    manager.send(
      {
        id: randomUUID(),
        channel: draft.channel as NotificationChannel,
        title: draft.title,
        body: draft.body,
        project: draft.project,
        agentId: null,
        priority: draft.priority,
        createdAt: new Date(),
        // add-api-error-notification (nx-06bbb): thread the draft's optional
        // severity onto the manager arg, which already accepts `severity` and
        // defaults a missing value to "info". `apiErrorRule` sets "error" so
        // the Swift dashboard surfaces api-error rows with error urgency.
        ...(draft.severity ? { severity: draft.severity } : {}),
      },
      // nx-20caf: thread the CC custom session name through as a transport-only
      // extra (no DB column) so it reaches the NotificationFired envelope.
      // mx-7i4k: also thread the CC session id for iOS tap-to-session deep-link.
      draft.sessionName || draft.sessionId
        ? { sessionName: draft.sessionName, sessionId: draft.sessionId }
        : undefined,
    ),
  );

  const results = await Promise.allSettled(sends);
  for (const [i, result] of results.entries()) {
    if (result.status === "rejected") {
      log.warn(
        { err: result.reason, eventType, channel: filtered[i]?.channel },
        "manager.send threw inside hook trigger — continuing",
      );
    }
  }
}

// ─── Test utilities ──────────────────────────────────────────────────────────

/** Clear the suppression cache (test-only — no production caller). */
export function _clearSuppressionForTests(): void {
  suppressionCache.clear();
}

/** Read suppression cache size (test-only). */
export function _suppressionSizeForTests(): number {
  return suppressionCache.size;
}
