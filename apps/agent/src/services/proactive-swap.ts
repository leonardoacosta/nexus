/**
 * Proactive credential swap evaluator.
 *
 * Spec: openspec/changes/credential-proactive-swap
 *
 * Invoked at the end of each successful usage-poller tick. Rotation today is
 * reactive (`rate-limit-interceptor` swaps only after a 429). This evaluator
 * uses the freshly-polled 5h headroom to rotate BEFORE the wall:
 *
 *   1. Resolve the ACTIVE credential (via the active-credential-watcher
 *      fingerprint) and compute its 5h remaining ratio `(limit - used) / limit`.
 *      Bail when it still has > 10% headroom, or when there is no usable data.
 *   2. Swap branch — when the active credential is at/below 10%, rank the other
 *      primary+available rows by 5h remaining (desc), drop any at/below 10%, and
 *      `pool.manualSwap()` into the one with the MOST headroom. Skip entirely if
 *      a swap happened in the last 30 min (anti-flap). Fall through to the next
 *      candidate on a cooldown error.
 *   3. Ladder branch — when the active credential is low AND no eligible
 *      candidate exists, emit graduated `NotificationFired` events (tts +
 *      desktop) as remaining crosses 10/8/4/2/0%, once per 5h window, naming the
 *      soonest-resetting account + reset time.
 *
 * All state (ladder dedup) is in-memory per agent process — a restart at worst
 * re-fires one duplicate notification, which the spec accepts.
 */

import type { Db } from "@nexus/db";
import { credentials } from "@nexus/db";
import { and, eq } from "drizzle-orm";
import { createLogger } from "@nexus/core/node";
import type { CredentialPool } from "../credentials/pool";
import { getActiveCredentialSnapshot } from "../credentials/credential-watcher";
import { emitAudit as defaultEmitAudit } from "../routes/credentials/shared";
import type { CredentialAuditEntry } from "../routes/credentials/shared";
import { lifecycleBus } from "./lifecycle-bus";
import type { NotificationFiredPayload } from "./lifecycle-bus";

const log = createLogger("agent:services:proactive-swap");

/** Rotate / warn once the active credential is at or below this 5h remaining ratio. */
const REMAINING_THRESHOLD = 0.1;

/** Anti-flap: skip the swap branch if a swap happened within this window. */
const ANTI_FLAP_MS = 30 * 60 * 1000;

/**
 * Ladder alert levels (percent remaining), descending. Each fires at most once
 * per 5h window. See `thresholdsToFire` for the crossing semantics.
 */
const LADDER_THRESHOLDS = [10, 8, 4, 2, 0] as const;

/** Minimal swap-tracker surface — the module singleton or a test stub. */
export interface SwapTrackerLike {
  lastSwapAt(fingerprint: string): Date | null;
}

export interface EvaluateProactiveSwapOpts {
  db: Db;
  /** Only `manualSwap` is used; `Pick` keeps the test surface tiny. */
  pool: Pick<CredentialPool, "manualSwap">;
  swapTracker: SwapTrackerLike;

  // ── Test seams (default to the real singletons in production) ──────────────
  /** Clock override. */
  now?: () => Date;
  /** Active-credential fingerprint resolver (defaults to the watcher snapshot). */
  activeFingerprint?: () => string | null;
  /** Notification sink (defaults to `lifecycleBus.emit("NotificationFired", …)`). */
  notify?: (payload: NotificationFiredPayload) => void;
  /** Audit sink (defaults to the credential audit logger). */
  audit?: (entry: CredentialAuditEntry) => void;
}

/** One primary+available credential's 5h usage snapshot. */
interface UsageRow {
  id: string;
  fingerprint: string;
  accountEmail: string | null;
  used: number | null;
  limit: number | null;
  resetAt: Date | null;
}

/**
 * In-memory ladder dedup: fingerprint → { the 5h window instant we armed for,
 * set of thresholds already fired for that window }. Re-armed when `resetAt`
 * changes (a new 5h window).
 */
const ladderState = new Map<string, { resetAt: string | null; fired: Set<number> }>();

/** Test-only: clear ladder dedup state between cases. */
export function __resetLadderStateForTests(): void {
  ladderState.clear();
}

/** Remaining ratio `(limit - used) / limit`, or null when there is no usable data. */
function remainingRatio(row: Pick<UsageRow, "used" | "limit">): number | null {
  if (row.limit == null || row.limit === 0 || row.used == null) return null;
  return (row.limit - row.used) / row.limit;
}

async function queryUsageRows(db: Db): Promise<UsageRow[]> {
  return db
    .select({
      id: credentials.id,
      fingerprint: credentials.fingerprint,
      accountEmail: credentials.accountEmail,
      used: credentials.usage5hUsed,
      limit: credentials.usage5hLimit,
      resetAt: credentials.usage5hResetAt,
    })
    .from(credentials)
    .where(
      and(eq(credentials.isPrimary, true), eq(credentials.status, "available")),
    );
}

/**
 * Thresholds to fire at `remainingPct`: every level already CROSSED
 * (`remainingPct <= T`) plus the single greatest level still APPROACHING
 * (`T < remainingPct`). At 9% remaining this yields {10, 8} — the crossed 10
 * and the approaching 8 — matching the spec's "11% -> 9% fires 10% and 8%".
 * At 0% it yields the full ladder. The caller filters out already-fired levels.
 */
function thresholdsToFire(remainingPct: number): number[] {
  const fire = new Set<number>();
  for (const t of LADDER_THRESHOLDS) {
    if (remainingPct <= t) fire.add(t);
  }
  const below = LADDER_THRESHOLDS.filter((t) => t < remainingPct);
  if (below.length > 0) fire.add(Math.max(...below));
  return [...fire];
}

/** Soonest-resetting account among rows carrying a `resetAt`. */
function soonestResetting(rows: UsageRow[]): UsageRow | null {
  let best: UsageRow | null = null;
  for (const r of rows) {
    if (!r.resetAt) continue;
    if (!best || (best.resetAt && r.resetAt.getTime() < best.resetAt.getTime())) {
      best = r;
    }
  }
  return best;
}

function ladderMessage(pct: number, soonest: UsageRow | null): string {
  const who = soonest?.accountEmail ?? "an account";
  const when = soonest?.resetAt ? soonest.resetAt.toISOString() : "unknown";
  return `Credential headroom at ${pct}% and no swap candidate is available. Soonest reset: ${who} at ${when}.`;
}

function runLadder(
  active: UsageRow,
  rows: UsageRow[],
  ratio: number,
  notify: (payload: NotificationFiredPayload) => void,
): void {
  const pct = ratio * 100;
  const resetKey = active.resetAt ? active.resetAt.toISOString() : null;

  let st = ladderState.get(active.fingerprint);
  if (!st || st.resetAt !== resetKey) {
    // New 5h window (or first observation) — re-arm the ladder.
    st = { resetAt: resetKey, fired: new Set<number>() };
    ladderState.set(active.fingerprint, st);
  }

  const toFire = thresholdsToFire(pct)
    .filter((t) => !st!.fired.has(t))
    .sort((a, b) => b - a);
  if (toFire.length === 0) return;

  const soonest = soonestResetting(rows);
  for (const t of toFire) {
    st.fired.add(t);
    const body = ladderMessage(t, soonest);
    const base = {
      title: "Credential headroom low",
      body,
      message: body,
    };
    notify({ ...base, id: `proactive-swap-ladder-${t}-desktop-${Date.now()}`, channel: "desktop" });
    notify({ ...base, id: `proactive-swap-ladder-${t}-tts-${Date.now()}`, channel: "tts" });
  }
  log.info(
    { fingerprint: active.fingerprint, fired: toFire, remainingPct: pct },
    "proactive-swap: ladder notifications emitted",
  );
}

/**
 * Evaluate the active credential's 5h headroom and, when low, either rotate to
 * a fresher credential or emit the graduated exhaustion ladder. Never throws in
 * the expected paths — the poller wraps the call defensively regardless.
 */
export async function evaluateProactiveSwap(
  opts: EvaluateProactiveSwapOpts,
): Promise<void> {
  const { db, pool, swapTracker } = opts;
  const now = opts.now ?? (() => new Date());
  const notify =
    opts.notify ?? ((p: NotificationFiredPayload) => lifecycleBus.emit("NotificationFired", p));
  const audit = opts.audit ?? defaultEmitAudit;
  const activeFingerprint =
    opts.activeFingerprint ?? (() => getActiveCredentialSnapshot().fingerprint);

  const rows = await queryUsageRows(db);
  if (rows.length === 0) return;

  const activeFp = activeFingerprint();
  const active = activeFp ? rows.find((r) => r.fingerprint === activeFp) : undefined;
  if (!active) {
    log.debug({ activeFp }, "proactive-swap: active credential not among pollable rows");
    return;
  }

  const activeRatio = remainingRatio(active);
  if (activeRatio === null) return; // no usable data / limit 0
  if (activeRatio > REMAINING_THRESHOLD) return; // healthy — nothing to do

  // Rank the other rows by remaining headroom, keeping only eligible ones.
  const candidates = rows
    .filter((r) => r.id !== active.id)
    .map((r) => ({ row: r, ratio: remainingRatio(r) }))
    .filter(
      (c): c is { row: UsageRow; ratio: number } =>
        c.ratio !== null && c.ratio > REMAINING_THRESHOLD,
    )
    .sort((a, b) => b.ratio - a.ratio);

  if (candidates.length === 0) {
    // No eligible swap target — graduated exhaustion ladder.
    runLadder(active, rows, activeRatio, notify);
    return;
  }

  // Anti-flap: skip if the active credential was swapped within the last 30 min.
  const last = swapTracker.lastSwapAt(active.fingerprint);
  if (last && now().getTime() - last.getTime() < ANTI_FLAP_MS) {
    log.info(
      { fingerprint: active.fingerprint, lastSwapAt: last.toISOString() },
      "proactive-swap: within anti-flap window, skipping swap",
    );
    return;
  }

  for (const cand of candidates) {
    try {
      const result = await pool.manualSwap(cand.row.id);
      if (!result) continue; // target vanished — try the next candidate
      const ts = now().toISOString();
      audit({
        event: "credential.auto_swap_out",
        credential_id: active.id,
        claimed_actor: "auto-usage",
        claimed_ip: "agent",
        timestamp_iso: ts,
      });
      audit({
        event: "credential.auto_swap_in",
        credential_id: cand.row.id,
        claimed_actor: "auto-usage",
        claimed_ip: "agent",
        timestamp_iso: ts,
      });
      log.info(
        {
          from: active.id,
          to: cand.row.id,
          activeRemaining: activeRatio,
          targetRemaining: cand.ratio,
        },
        "proactive-swap: rotated active credential",
      );
      return;
    } catch (err) {
      if (err instanceof Error && err.message === "target credential is in cooldown") {
        log.debug(
          { targetId: cand.row.id },
          "proactive-swap: candidate in cooldown, trying next",
        );
        continue;
      }
      // Unexpected error — surface to the poller's defensive wrapper.
      throw err;
    }
  }

  log.info(
    { fingerprint: active.fingerprint },
    "proactive-swap: all candidates in cooldown, no swap performed",
  );
}
