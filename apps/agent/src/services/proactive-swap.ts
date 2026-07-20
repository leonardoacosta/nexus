/**
 * Proactive credential swap evaluator.
 *
 * Spec: openspec/changes/credential-proactive-swap, retuned by
 * openspec/changes/wire-reactive-rate-limit-swap (task 2.6 — "squeeze-dry").
 *
 * Invoked at the end of each successful usage-poller tick. This evaluator
 * uses the freshly-polled 5h/7d headroom to rotate BEFORE the reactive
 * interceptor (`services/socket-server/dispatcher.ts`) has to catch it:
 *
 *   1. Resolve the ACTIVE credential (via the active-credential-watcher
 *      fingerprint) and compute its EFFECTIVE remaining ratio —
 *      `min(5h remaining, 7d remaining)` — since either window burns out
 *      independently on wall-clock. Bail when it still has > 2% headroom on
 *      both windows, or when there is no usable data.
 *   2. Swap branch — when the active credential is at/below 2% effective
 *      remaining, rank the other primary+available rows by effective
 *      remaining (desc), drop any at/below 2%, and swap (via the shared
 *      `performCredentialSwap` flow) into the one with the MOST headroom.
 *      Skip entirely if a swap happened in the last 10 min (anti-flap). Fall
 *      through to the next candidate on a cooldown error.
 *   3. Ladder branch — when the active credential is low AND no eligible
 *      candidate exists, emit graduated `NotificationFired` events (tts +
 *      desktop) as effective remaining crosses 10/8/4/2/0%, once per 5h
 *      window, naming the soonest-resetting account + reset time.
 *
 * Riding each account to 98% utilization (2% remaining) before rotating uses
 * the full window instead of stranding headroom the old 10%-remaining
 * threshold left on the table — see design.md Decision 5.
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
import { registerSnapshotSource } from "./state-snapshot";
import { performCredentialSwap } from "./credential-swap-flow";

const log = createLogger("agent:services:proactive-swap");

/**
 * Rotate / warn once the active credential's EFFECTIVE remaining
 * (`min(5h, 7d)`) is at or below this ratio. 0.02 (98% utilization) — see
 * design.md Decision 5 for why this replaced the original 0.10.
 */
const REMAINING_THRESHOLD = 0.02;

/** Anti-flap: skip the swap branch if a swap happened within this window. */
const ANTI_FLAP_MS = 10 * 60 * 1000;

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

/** One primary+available credential's 5h + 7d usage snapshot. */
interface UsageRow {
  id: string;
  fingerprint: string;
  accountEmail: string | null;
  used: number | null;
  limit: number | null;
  resetAt: Date | null;
  used7d: number | null;
  limit7d: number | null;
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

// Persist the ladder dedup across restarts (nx-veo5g.4, Layer D). Without this,
// a restart re-arms an empty ladder and can re-fire an exhaustion notification
// already sent for the current 5h window. `resetAt` carries the window identity,
// so a genuinely new window still re-arms correctly after restore.
registerSnapshotSource("proactive-swap-ladder", {
  serialize: () =>
    [...ladderState.entries()].map(([fp, st]) => [
      fp,
      { resetAt: st.resetAt, fired: [...st.fired] },
    ]),
  deserialize: (data) => {
    ladderState.clear();
    for (const [fp, st] of data as [
      string,
      { resetAt: string | null; fired: number[] },
    ][]) {
      if (typeof fp !== "string" || !st || !Array.isArray(st.fired)) continue;
      ladderState.set(fp, {
        resetAt: st.resetAt ?? null,
        fired: new Set(st.fired.filter((n) => typeof n === "number")),
      });
    }
  },
});

/** Ratio `(limit - used) / limit` for one window, or null when there is no usable data. */
function remainingRatio(used: number | null, limit: number | null): number | null {
  if (limit == null || limit === 0 || used == null) return null;
  return (limit - used) / limit;
}

/**
 * Effective remaining ratio across BOTH usage windows — `min(5h, 7d)` — since
 * either window burns out on wall-clock regardless of which is checked
 * (design.md Decision 5, task 2.6: "a 7d-exhausted account is just as
 * unusable as a 5h-exhausted one"). Null only when NEITHER window has usable
 * data; a single usable window is returned as-is.
 */
function effectiveRemaining(row: Pick<UsageRow, "used" | "limit" | "used7d" | "limit7d">): number | null {
  const r5h = remainingRatio(row.used, row.limit);
  const r7d = remainingRatio(row.used7d, row.limit7d);
  if (r5h === null) return r7d;
  if (r7d === null) return r5h;
  return Math.min(r5h, r7d);
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
      used7d: credentials.usage7dUsed,
      limit7d: credentials.usage7dLimit,
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

  const activeRatio = effectiveRemaining(active);
  if (activeRatio === null) return; // no usable data / limit 0 on either window
  if (activeRatio > REMAINING_THRESHOLD) return; // healthy — nothing to do

  // Rank the other rows by effective remaining headroom, keeping only eligible ones.
  const candidates = rows
    .filter((r) => r.id !== active.id)
    .map((r) => ({ row: r, ratio: effectiveRemaining(r) }))
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

  // Anti-flap: skip if the active credential was swapped within the last 10 min.
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
      const outcome = await performCredentialSwap({
        db,
        pool,
        targetId: cand.row.id,
        reason: "proactive",
        now,
        notify,
        audit,
      });
      if (!outcome.ok) continue; // target vanished — try the next candidate
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
