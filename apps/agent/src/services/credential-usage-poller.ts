/**
 * CredentialUsagePoller — periodic fetch of Anthropic /api/oauth/usage
 * for every primary, available credential.
 *
 * Spec: openspec/changes/credentials-account-resolve-and-usage (task 2.1)
 *
 * On each tick:
 *   1. Query rows where `is_primary = true AND status = 'available'`.
 *   2. Decrypt each row's access token via the pool's `getDecrypted`.
 *   3. Fan out 4-concurrent fetches to
 *      `https://api.anthropic.com/api/oauth/usage` (10 s timeout each).
 *   4. Defensively parse the response — live shape (confirmed 2026-07-11,
 *      nx-8ahjt) is `{ five_hour: {utilization, resets_at, limit_dollars,
 *      used_dollars, ...}, seven_day: {...}, ... }`; `utilization` (a
 *      0-100 percent) maps onto `used`/`limit=100`. A legacy `{used, limit}`
 *      shape is still accepted defensively (see `pickWindow`).
 *   5. Persist the snapshot to the row's seven usage columns plus
 *      `usagePolledAt`. Failures never throw — they are logged and counted.
 *   6. If >50% of attempted calls failed in the tick, the next tick is
 *      delayed to the back-off interval (30 min); a successful tick resets
 *      it back to the configured interval.
 *
 * The poller is intentionally separate from the credential pool: the pool
 * owns lease/cooldown semantics, the poller is a passive observer. They
 * share `pool.getDecrypted(id)` for ciphertext access.
 */

import type { Db } from "@nexus/db";
import { credentials, credentialPolls } from "@nexus/db";
import { eq, and, isNull } from "drizzle-orm";
import { createLogger } from "@nexus/core/node";
import { fetchWithTimeout } from "@nexus/core/fetch";
import { runPool } from "../utils/run-pool";
import type { CredentialPool } from "../credentials/pool";

const log = createLogger("agent:services:credential-usage-poller");

/** Default poll interval. Overridable via `NEXUS_USAGE_POLL_INTERVAL_MS`. */
const DEFAULT_INTERVAL_MS = 5 * 60 * 1000;

/** Back-off interval triggered when >50% of calls fail in a tick. */
const BACKOFF_INTERVAL_MS = 30 * 60 * 1000;

/** Per-call fetch timeout. */
const FETCH_TIMEOUT_MS = 10_000;

/** Max parallel /api/oauth/usage calls per tick (Anthropic friendliness). */
const POLL_CONCURRENCY = 4;

/** Anthropic usage endpoint URL. */
const USAGE_URL = "https://api.anthropic.com/api/oauth/usage";

/** Parsed window snapshot used internally before column-write. */
interface WindowSnapshot {
  used: number;
  limit: number;
  resetsAt: Date | null;
}

/** Parsed response payload (defensive — unknown keys ignored). */
interface UsagePayload {
  fiveHour: WindowSnapshot;
  sevenDay: WindowSnapshot;
}

/** Service handle returned from `startCredentialUsagePoller`. */
export interface CredentialUsagePollerService {
  stop(): void;
  /** Exposed for tests — run one tick synchronously and await the result. */
  tickOnce(): Promise<{
    attempted: number;
    succeeded: number;
    failed: number;
    backedOff: boolean;
  }>;
}

export interface StartCredentialUsagePollerOpts {
  db: Db;
  pool: CredentialPool;
  /** Override the wall-clock interval (testing + env var). */
  intervalMs?: number;
  /** Override the back-off interval (testing). */
  backoffMs?: number;
  /** Override the per-fetch timeout (testing). */
  fetchTimeoutMs?: number;
  /**
   * Proactive-swap evaluator, invoked at the end of each successful (non-backed-off)
   * tick with the freshly-polled usage data. Injected so tests can stub it and so
   * the poller stays decoupled from the swap logic. Failures are logged, never
   * thrown into the tick. See `services/proactive-swap.ts`.
   */
  onTickComplete?: (deps: { db: Db; pool: CredentialPool }) => Promise<void>;
}

/**
 * Defensively parse an /api/oauth/usage JSON body into `UsagePayload`.
 *
 * Returns `null` when neither window is recognisable — callers MUST NOT
 * overwrite existing row data on null.
 */
export function parseUsageBody(body: unknown): UsagePayload | null {
  if (!body || typeof body !== "object") return null;
  const root = body as Record<string, unknown>;

  // Anthropic ships snake_case keys on this endpoint.
  const fiveRaw = root.five_hour ?? root.fiveHour;
  const sevenRaw = root.seven_day ?? root.sevenDay;

  const fiveHour = pickWindow(fiveRaw);
  const sevenDay = pickWindow(sevenRaw);

  // If both windows fail to parse, surface null so the caller skips the row.
  if (!fiveHour && !sevenDay) return null;

  return {
    fiveHour: fiveHour ?? { used: 0, limit: 0, resetsAt: null },
    sevenDay: sevenDay ?? { used: 0, limit: 0, resetsAt: null },
  };
}

function pickWindow(raw: unknown): WindowSnapshot | null {
  if (!raw || typeof raw !== "object") return null;
  const obj = raw as Record<string, unknown>;

  const resetsRaw = obj.resets_at ?? obj.resetsAt;
  let resetsAt: Date | null = null;
  if (typeof resetsRaw === "string" && resetsRaw.length > 0) {
    const d = new Date(resetsRaw);
    if (!Number.isNaN(d.getTime())) resetsAt = d;
  } else if (typeof resetsRaw === "number" && Number.isFinite(resetsRaw)) {
    // Accept epoch-seconds OR epoch-millis.
    const ms = resetsRaw > 1_000_000_000_000 ? resetsRaw : resetsRaw * 1000;
    const d = new Date(ms);
    if (!Number.isNaN(d.getTime())) resetsAt = d;
  }

  // Live Anthropic /api/oauth/usage shape (confirmed against production,
  // nx-8ahjt root cause 2026-07-11): each window is `{ utilization: <percent
  // 0-100 float>, resets_at, limit_dollars, used_dollars, remaining_dollars }`
  // — there is no `used`/`limit` pair at all, so the pre-fix parser (which
  // only looked for `used`/`limit`) treated every real response as
  // unparseable and counted it as a failure. Map the percentage onto the
  // existing integer used/limit(=100) columns so downstream ratio math
  // (`(limit - used) / limit` in proactive-swap.ts, Swift dashboard) keeps
  // working unmodified — no schema migration needed.
  if (typeof obj.utilization === "number" && Number.isFinite(obj.utilization)) {
    return {
      used: Math.round(obj.utilization),
      limit: 100,
      resetsAt,
    };
  }

  // Defensive fallback: an explicit used+limit shape. Never observed live,
  // kept in case Anthropic reverts or a different response variant appears
  // (mirrors this file's existing snake_case/camelCase defensive parsing).
  const used = toInt(obj.used);
  const limit = toInt(obj.limit);
  if (used === null && limit === null) return null;
  return {
    used: used ?? 0,
    limit: limit ?? 0,
    resetsAt,
  };
}

function toInt(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return Math.trunc(v);
  if (typeof v === "string") {
    const n = Number.parseInt(v, 10);
    if (Number.isFinite(n)) return n;
  }
  return null;
}

/**
 * Run a single poll attempt against one access token.
 *
 * Returns the parsed usage payload, or null on transport / parse failure
 * (caller logs + counts; row is left untouched).
 */
async function pollSingle(
  credentialId: string,
  accessToken: string,
  fetchTimeoutMs: number,
): Promise<UsagePayload | null> {
  try {
    const res = await fetchWithTimeout(USAGE_URL, {
      headers: { Authorization: `Bearer ${accessToken}` },
      timeout: fetchTimeoutMs,
    });
    if (!res.ok) {
      log.debug(
        { credentialId, status: res.status },
        "usage probe returned non-2xx",
      );
      return null;
    }
    const body = (await res.json()) as unknown;
    return parseUsageBody(body);
  } catch (err) {
    log.debug(
      { credentialId, err: err instanceof Error ? err.message : String(err) },
      "usage probe threw",
    );
    return null;
  }
}

/** Extract the OAuth access token from a credential's decrypted plaintext. */
function extractAccessToken(plaintext: string | null): string | null {
  if (!plaintext) return null;
  try {
    const parsed = JSON.parse(plaintext);
    const token = parsed?.claudeAiOauth?.accessToken;
    return typeof token === "string" && token.length > 0 ? token : null;
  } catch {
    return null;
  }
}

/**
 * Persist a parsed usage snapshot: overwrite the credentials row's current
 * state, then append one immutable `credential_polls` history row. Both writes
 * happen only on a successful parse — a null payload never reaches here.
 */
async function writeSnapshot(
  db: Db,
  credentialId: string,
  fingerprint: string,
  payload: UsagePayload,
): Promise<void> {
  const polledAt = new Date();
  await db
    .update(credentials)
    .set({
      usage5hUsed: payload.fiveHour.used,
      usage5hLimit: payload.fiveHour.limit,
      usage5hResetAt: payload.fiveHour.resetsAt,
      usage7dUsed: payload.sevenDay.used,
      usage7dLimit: payload.sevenDay.limit,
      usage7dResetAt: payload.sevenDay.resetsAt,
      usagePolledAt: polledAt,
    })
    .where(eq(credentials.id, credentialId));

  // Append-only history row — one per polled account per successful tick.
  await db.insert(credentialPolls).values({
    credentialId,
    fingerprint,
    usage5hUsed: payload.fiveHour.used,
    usage5hLimit: payload.fiveHour.limit,
    usage7dUsed: payload.sevenDay.used,
    usage7dLimit: payload.sevenDay.limit,
    usage5hResetAt: payload.fiveHour.resetsAt,
    usage7dResetAt: payload.sevenDay.resetsAt,
    polledAt,
  });
}

interface PrimaryAvailableRow {
  id: string;
  accountEmail: string | null;
  fingerprint: string;
}

/** Query rows that should be polled this tick. */
async function queryPollableRows(db: Db): Promise<PrimaryAvailableRow[]> {
  const rows = await db
    .select({
      id: credentials.id,
      accountEmail: credentials.accountEmail,
      fingerprint: credentials.fingerprint,
    })
    .from(credentials)
    .where(
      and(
        eq(credentials.isPrimary, true),
        eq(credentials.status, "available"),
      ),
    );
  return rows;
}

/** Re-export so route handlers can call the same shape if needed. */
export async function queryBlankIdentityRows(
  db: Db,
): Promise<{ id: string }[]> {
  return db
    .select({ id: credentials.id })
    .from(credentials)
    .where(isNull(credentials.accountEmail));
}

/**
 * Start the credential usage poller. Returns a service handle with
 * `stop()` plus a `tickOnce()` helper used by tests.
 */
export function startCredentialUsagePoller(
  opts: StartCredentialUsagePollerOpts,
): CredentialUsagePollerService {
  const intervalMs =
    opts.intervalMs ??
    (process.env.NEXUS_USAGE_POLL_INTERVAL_MS
      ? Number.parseInt(process.env.NEXUS_USAGE_POLL_INTERVAL_MS, 10)
      : DEFAULT_INTERVAL_MS);
  const backoffMs = opts.backoffMs ?? BACKOFF_INTERVAL_MS;
  const fetchTimeoutMs = opts.fetchTimeoutMs ?? FETCH_TIMEOUT_MS;
  const { db, pool, onTickComplete } = opts;

  let timer: ReturnType<typeof setTimeout> | null = null;
  let stopped = false;

  async function tick(): Promise<{
    attempted: number;
    succeeded: number;
    failed: number;
    backedOff: boolean;
  }> {
    const rows = await queryPollableRows(db);
    if (rows.length === 0) {
      log.debug("no primary+available credentials to poll");
      return { attempted: 0, succeeded: 0, failed: 0, backedOff: false };
    }

    let succeeded = 0;
    let failed = 0;
    let attempted = 0;

    await runPool(rows, POLL_CONCURRENCY, async (row) => {
      // Decrypt outside the parallel HTTP call so a decrypt failure is
      // counted as a failure (not silently dropped).
      let plaintext: string | null = null;
      try {
        plaintext = await pool.getDecrypted(row.id);
      } catch (err) {
        log.warn(
          { id: row.id, err: err instanceof Error ? err.message : String(err) },
          "usage poller: decrypt failed",
        );
      }
      const token = extractAccessToken(plaintext);
      if (!token) {
        // Not a failure of the remote endpoint — skip without counting.
        return;
      }
      attempted++;

      const payload = await pollSingle(row.id, token, fetchTimeoutMs);
      if (payload === null) {
        failed++;
        return;
      }

      try {
        await writeSnapshot(db, row.id, row.fingerprint, payload);
        succeeded++;

        // Opportunistic identity re-probe for rows whose accountEmail is
        // still blank. Fire-and-forget; pool.probeIdentity logs failures.
        if (!row.accountEmail && plaintext) {
          pool.probeIdentity(row.id, plaintext).catch((err) =>
            log.debug(
              {
                id: row.id,
                err: err instanceof Error ? err.message : String(err),
              },
              "usage poller: opportunistic identity probe failed",
            ),
          );
        }
      } catch (err) {
        failed++;
        log.warn(
          { id: row.id, err: err instanceof Error ? err.message : String(err) },
          "usage poller: row update failed",
        );
      }
    });

    const backedOff = attempted > 0 && failed / attempted > 0.5;
    log.info(
      { attempted, succeeded, failed, backedOff },
      "credential-usage-poller tick complete",
    );

    // Proactive-swap evaluation runs on the freshly-persisted usage snapshot at
    // the end of a successful tick. Defensive: a throw here is logged, never
    // propagated into the tick (which would trigger the error re-schedule path).
    if (onTickComplete && !backedOff) {
      try {
        await onTickComplete({ db, pool });
      } catch (err) {
        log.warn(
          { err: err instanceof Error ? err.message : String(err) },
          "credential-usage-poller: onTickComplete (proactive-swap) failed (non-fatal)",
        );
      }
    }

    return { attempted, succeeded, failed, backedOff };
  }

  function schedule(delayMs: number): void {
    if (stopped) return;
    timer = setTimeout(() => {
      if (stopped) return;
      tick()
        .then((result) => {
          const next = result.backedOff ? backoffMs : intervalMs;
          if (result.backedOff) {
            log.warn(
              { failureRate: result.failed / Math.max(1, result.attempted) },
              "credential-usage-poller: >50% calls failed, backing off",
            );
          }
          schedule(next);
        })
        .catch((err) => {
          log.error(
            { err: err instanceof Error ? err.message : String(err) },
            "credential-usage-poller tick threw (re-scheduling at default interval)",
          );
          schedule(intervalMs);
        });
    }, delayMs);
  }

  // Kick off the first tick on the configured interval (NOT at startup —
  // we don't want to hammer Anthropic immediately on agent boot when the
  // operator is debugging).
  schedule(intervalMs);

  log.info(
    { intervalMs, backoffMs, concurrency: POLL_CONCURRENCY },
    "credential-usage-poller started",
  );

  return {
    stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
      timer = null;
      log.info("credential-usage-poller stopped");
    },
    tickOnce: tick,
  };
}
