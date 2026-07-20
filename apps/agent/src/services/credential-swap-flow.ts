/**
 * Shared credential-swap execution flow.
 *
 * Spec: openspec/changes/wire-reactive-rate-limit-swap (task 2.1)
 *
 * Wraps `pool.manualSwap()` with the full set of swap side effects that used
 * to be duplicated (proactive-swap's audit calls) or missing entirely
 * (nothing ever wrote `credential_swaps` — see proposal.md § Why):
 *
 *   1. `pool.manualSwap(targetId)` — parks the current best-available
 *      credential on cooldown and activates `targetId`.
 *   2. swap-tracker `recordSwap()` — stamps both fingerprints (backs the
 *      anti-flap windows both trigger paths use).
 *   3. `emitAudit()` — the existing credential-event audit sink.
 *   4. `credential_swaps` insert — the durable "did a swap happen and why"
 *      trail (implements the never-wired `credential-analytics` requirement).
 *   5. `NotificationFired` ("swapped <from> → <to>") on tts+desktop.
 *
 * Both the reactive dispatcher path (`socket-server/dispatcher.ts`) and the
 * proactive usage-poller evaluator (`proactive-swap.ts`) call this instead of
 * hand-rolling the sequence, so "did a swap happen and why" is answerable
 * from one table regardless of trigger.
 *
 * `manualSwap`'s "target credential is in cooldown" rejection is NOT caught
 * here — it propagates so callers that fall through to the next ranked
 * candidate (proactive-swap's candidate loop) keep working unchanged.
 */

import type { Db } from "@nexus/db";
import { credentialSwaps } from "@nexus/db";
import { createLogger } from "@nexus/core/node";
import type { CredentialPool } from "../credentials/pool";
import type { ManualSwapResult } from "../credentials/pool/types";
import { recordSwap } from "./credential-pool/swap-tracker";
import { emitAudit as defaultEmitAudit } from "../routes/credentials/shared";
import type { CredentialAuditEntry } from "../routes/credentials/shared";
import { lifecycleBus } from "./lifecycle-bus";
import type { NotificationFiredPayload } from "./lifecycle-bus";

const log = createLogger("agent:services:credential-swap-flow");

/** Why `performCredentialSwap` was invoked — persisted verbatim to `credential_swaps.reason`. */
export type SwapReason = "reactive" | "proactive";

export interface PerformCredentialSwapOpts {
  db: Db;
  /** Only `manualSwap` is used; `Pick` keeps the test surface tiny (mirrors proactive-swap's own opts). */
  pool: Pick<CredentialPool, "manualSwap">;
  /** Credential to activate — the pool parks the current best-available in its place. */
  targetId: string;
  reason: SwapReason;
  /** Session that triggered the swap. Reactive always has one; proactive omits it (poller-triggered, no single session). */
  sessionId?: string;

  // ── Test seams (default to the real singletons in production) ──────────────
  now?: () => Date;
  notify?: (payload: NotificationFiredPayload) => void;
  audit?: (entry: CredentialAuditEntry) => void;
}

export interface CredentialSwapOutcome {
  /** False when `targetId` does not exist (manualSwap returned null) — no side effects ran. */
  ok: boolean;
  result: ManualSwapResult | null;
}

/** Human label for a swap-side row: prefer the account name, then email, then fingerprint. */
function accountLabel(
  row: { accountName?: string | null; accountEmail?: string | null; fingerprint: string } | null,
): string {
  if (!row) return "none";
  return row.accountName ?? row.accountEmail ?? row.fingerprint;
}

/**
 * Run a credential swap through the full side-effect chain described above.
 * Resolves to `{ ok: false, result: null }` (no side effects) when
 * `targetId` doesn't exist; throws when `manualSwap` throws (cooldown case)
 * so candidate-fallback loops keep working.
 */
export async function performCredentialSwap(
  opts: PerformCredentialSwapOpts,
): Promise<CredentialSwapOutcome> {
  const { db, pool, targetId, reason, sessionId } = opts;
  const now = opts.now ?? (() => new Date());
  const notify =
    opts.notify ?? ((p: NotificationFiredPayload) => lifecycleBus.emit("NotificationFired", p));
  const audit = opts.audit ?? defaultEmitAudit;

  const result = await pool.manualSwap(targetId);
  if (!result) {
    log.warn({ targetId, reason }, "credential-swap-flow: target credential not found");
    return { ok: false, result: null };
  }

  const fromFingerprint = result.parked?.fingerprint ?? null;
  const toFingerprint = result.activated.fingerprint;

  recordSwap(fromFingerprint, toFingerprint);

  const ts = now().toISOString();
  const claimedActor = reason === "reactive" ? "auto-reactive" : "auto-usage";
  if (result.parked) {
    audit({
      event: "credential.auto_swap_out",
      credential_id: result.parked.id,
      claimed_actor: claimedActor,
      claimed_ip: "agent",
      timestamp_iso: ts,
    });
  }
  audit({
    event: "credential.auto_swap_in",
    credential_id: result.activated.id,
    claimed_actor: claimedActor,
    claimed_ip: "agent",
    timestamp_iso: ts,
  });

  await db.insert(credentialSwaps).values({
    sessionId: sessionId ?? "system",
    fromFingerprint,
    toFingerprint,
    reason,
  });

  const body = `swapped ${accountLabel(result.parked)} → ${accountLabel(result.activated)}`;
  const base = { title: "Credential swapped", body, message: body };
  notify({ ...base, id: `credential-swap-${reason}-desktop-${Date.now()}`, channel: "desktop" });
  notify({ ...base, id: `credential-swap-${reason}-tts-${Date.now()}`, channel: "tts" });

  log.info(
    { from: fromFingerprint, to: toFingerprint, reason, sessionId },
    "credential-swap-flow: swap complete",
  );

  return { ok: true, result };
}

// ---------------------------------------------------------------------------
// Debounce (task 2.4)
// ---------------------------------------------------------------------------

/** 180s in-memory window: a session rate-limiting again inside it gets auto-continue only, no re-swap. */
const DEBOUNCE_MS = 180_000;

/** Per-session last-reactive-swap instant (epoch ms). Module-level singleton. */
const lastReactiveSwapBySession = new Map<string, number>();

/** True when `sessionId` had a reactive swap within the debounce window. */
export function isDebounced(sessionId: string, now: Date = new Date()): boolean {
  const last = lastReactiveSwapBySession.get(sessionId);
  if (last == null) return false;
  return now.getTime() - last < DEBOUNCE_MS;
}

/** Arm (or refresh) the debounce window for `sessionId` starting at `now`. */
export function armDebounce(sessionId: string, now: Date = new Date()): void {
  lastReactiveSwapBySession.set(sessionId, now.getTime());
}

/** Test-only: reset all tracked debounce state. */
export function __resetDebounceForTests(): void {
  lastReactiveSwapBySession.clear();
}
