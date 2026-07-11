/**
 * CredentialRefreshJob — proactive OAuth access-token refresh for pooled
 * credentials, EXCLUDING the currently-active one.
 *
 * Spec: fix-credential-usage-poller-100pct-failure (companion to the
 * active-credential-watcher.ts dedupe-gate fix).
 *
 * Root cause this job closes: every pooled credential's OAuth access token
 * was expired, because nothing besides Claude Code itself was ever
 * refreshing it — `active-credential-watcher.ts` only mirrors the *currently
 * active* CC session into the pool, so every OTHER account in the pool sat
 * with a stale access token until this job existed. Non-primary/secondary
 * accounts (anything CC isn't actively using right now) had no path to a
 * fresh token at all.
 *
 * On each tick:
 *   1. Query rows where `status = 'available' AND expires_at < now() + 15min`,
 *      excluding the fingerprint of the currently-active credential (that one
 *      is kept fresh by Claude Code itself + active-credential-watcher.ts;
 *      refreshing it here would fork its refresh-token chain out from under
 *      the live CC session).
 *   2. Fan out up to 4-concurrent refresh-grant calls via `runPool`.
 *   3. For each row: decrypt via `pool.getDecrypted`, extract the refresh
 *      token, call `refreshOAuthToken()`.
 *        - Success -> `pool.updateSecret()` with the new token material.
 *        - `invalid_grant` -> mark the row `status = 'refresh_failed'`
 *          (plain column value, no new schema) so both this job and
 *          `credential-usage-poller.ts` skip it going forward.
 *        - Any other error -> log and leave the row untouched; retried next
 *          tick.
 *   4. Interval: 5 minutes, aligned with `credential-usage-poller.ts`.
 */

import type { Db } from "@nexus/db";
import { credentials } from "@nexus/db";
import { eq, and, lt, ne } from "drizzle-orm";
import { createLogger } from "@nexus/core/node";
import { fetchWithTimeout } from "@nexus/core/fetch";
import { runPool } from "../utils/run-pool";
import type { CredentialPool } from "../credentials/pool";
import { refreshOAuthToken, OAuthRefreshError } from "../credentials/oauth-refresh";
import { getActiveCredentialSnapshot } from "../credentials/active-credential-watcher";

const log = createLogger("agent:services:credential-refresh-job");

/** Default tick interval. Aligned with credential-usage-poller.ts. */
const DEFAULT_INTERVAL_MS = 5 * 60 * 1000;

/** Refresh credentials whose access token expires within this window. */
const REFRESH_LOOKAHEAD_MS = 15 * 60 * 1000;

/** Per-call fetch timeout. */
const FETCH_TIMEOUT_MS = 10_000;

/** Max parallel refresh-grant calls per tick (mirrors the usage poller). */
const REFRESH_CONCURRENCY = 4;

export interface CredentialRefreshTickResult {
  attempted: number;
  succeeded: number;
  /** Rows marked `status = 'refresh_failed'` this tick (invalid_grant). */
  deadMarked: number;
  failed: number;
}

/** Service handle returned from `startCredentialRefreshJob`. */
export interface CredentialRefreshJobService {
  stop(): void;
  /** Exposed for tests — run one tick synchronously and await the result. */
  tickOnce(): Promise<CredentialRefreshTickResult>;
}

export interface StartCredentialRefreshJobOpts {
  db: Db;
  pool: CredentialPool;
  /** Override the wall-clock interval (testing). */
  intervalMs?: number;
  /** Override the per-refresh-call timeout (testing). */
  fetchTimeoutMs?: number;
  /**
   * Full override for the underlying fetch used by the refresh-grant call
   * (bypasses the default `fetchWithTimeout` wrapper entirely). Tests use
   * this to stub the Anthropic endpoint without touching the network.
   */
  fetchImpl?: typeof fetch;
}

interface RefreshableRow {
  id: string;
  fingerprint: string;
}

/** Query rows due for proactive refresh this tick. */
async function queryRefreshableRows(
  db: Db,
  threshold: Date,
  excludeFingerprint: string | null,
): Promise<RefreshableRow[]> {
  const conditions = [
    eq(credentials.status, "available"),
    lt(credentials.expiresAt, threshold),
  ];
  if (excludeFingerprint) {
    conditions.push(ne(credentials.fingerprint, excludeFingerprint));
  }
  return db
    .select({ id: credentials.id, fingerprint: credentials.fingerprint })
    .from(credentials)
    .where(and(...conditions));
}

/** Extract the OAuth refresh token from a credential's decrypted plaintext. */
function extractRefreshToken(plaintext: string): string | null {
  try {
    const parsed = JSON.parse(plaintext) as {
      claudeAiOauth?: { refreshToken?: unknown };
    };
    const token = parsed?.claudeAiOauth?.refreshToken;
    return typeof token === "string" && token.length > 0 ? token : null;
  } catch {
    return null;
  }
}

/**
 * Start the credential refresh job. Returns a service handle with `stop()`
 * plus a `tickOnce()` helper used by tests.
 */
export function startCredentialRefreshJob(
  opts: StartCredentialRefreshJobOpts,
): CredentialRefreshJobService {
  const intervalMs = opts.intervalMs ?? DEFAULT_INTERVAL_MS;
  const fetchTimeoutMs = opts.fetchTimeoutMs ?? FETCH_TIMEOUT_MS;
  const { db, pool } = opts;

  // Production default wraps the global fetch with a timeout, matching the
  // usage poller's per-call fetch discipline. A test-supplied fetchImpl
  // bypasses the wrapper entirely (no real network, no timeout semantics to
  // fake).
  const resolvedFetch: typeof fetch =
    opts.fetchImpl ??
    (((input, init) =>
      fetchWithTimeout(input as string | URL | Request, {
        ...(init as RequestInit | undefined),
        timeout: fetchTimeoutMs,
      })) as typeof fetch);

  let timer: ReturnType<typeof setTimeout> | null = null;
  let stopped = false;

  async function tick(): Promise<CredentialRefreshTickResult> {
    const threshold = new Date(Date.now() + REFRESH_LOOKAHEAD_MS);
    const activeFingerprint = getActiveCredentialSnapshot().fingerprint;
    const rows = await queryRefreshableRows(db, threshold, activeFingerprint);

    if (rows.length === 0) {
      log.debug("no credentials due for proactive refresh");
      return { attempted: 0, succeeded: 0, deadMarked: 0, failed: 0 };
    }

    let attempted = 0;
    let succeeded = 0;
    let deadMarked = 0;
    let failed = 0;

    await runPool(rows, REFRESH_CONCURRENCY, async (row) => {
      let plaintext: string | null = null;
      try {
        plaintext = await pool.getDecrypted(row.id);
      } catch (err) {
        log.warn(
          { id: row.id, err: err instanceof Error ? err.message : String(err) },
          "credential-refresh-job: decrypt failed",
        );
      }
      if (!plaintext) {
        // Not a failure of the refresh endpoint — skip without counting,
        // mirroring credential-usage-poller.ts's treatment of a missing token.
        return;
      }

      const refreshToken = extractRefreshToken(plaintext);
      if (!refreshToken) {
        return;
      }

      let parsedBlob: Record<string, unknown>;
      let oauthBlob: Record<string, unknown>;
      try {
        parsedBlob = JSON.parse(plaintext) as Record<string, unknown>;
        oauthBlob = (parsedBlob.claudeAiOauth as Record<string, unknown>) ?? {};
      } catch {
        return;
      }

      attempted++;

      try {
        const refreshed = await refreshOAuthToken(refreshToken, resolvedFetch);
        const newExpiresAt = new Date(Date.now() + refreshed.expiresInSec * 1000);
        const newBlob = {
          ...parsedBlob,
          claudeAiOauth: {
            ...oauthBlob,
            accessToken: refreshed.accessToken,
            refreshToken: refreshed.refreshToken,
            expiresAt: newExpiresAt.getTime(),
          },
        };
        await pool.updateSecret(row.id, newBlob, newExpiresAt);
        succeeded++;
      } catch (err) {
        if (err instanceof OAuthRefreshError && err.code === "invalid_grant") {
          try {
            await db
              .update(credentials)
              .set({ status: "refresh_failed" })
              .where(eq(credentials.id, row.id));
            deadMarked++;
            log.warn(
              { id: row.id },
              "credential-refresh-job: refresh token dead (invalid_grant) — marked refresh_failed",
            );
          } catch (updateErr) {
            failed++;
            log.error(
              {
                id: row.id,
                err: updateErr instanceof Error ? updateErr.message : String(updateErr),
              },
              "credential-refresh-job: failed to mark row refresh_failed",
            );
          }
          return;
        }
        failed++;
        log.warn(
          { id: row.id, err: err instanceof Error ? err.message : String(err) },
          "credential-refresh-job: refresh attempt failed (will retry next tick)",
        );
      }
    });

    log.info(
      { attempted, succeeded, deadMarked, failed },
      "credential-refresh-job tick complete",
    );
    return { attempted, succeeded, deadMarked, failed };
  }

  function schedule(delayMs: number): void {
    if (stopped) return;
    timer = setTimeout(() => {
      if (stopped) return;
      tick()
        .then(() => schedule(intervalMs))
        .catch((err) => {
          log.error(
            { err: err instanceof Error ? err.message : String(err) },
            "credential-refresh-job tick threw (re-scheduling at default interval)",
          );
          schedule(intervalMs);
        });
    }, delayMs);
  }

  // Kick off the first tick on the configured interval (NOT at startup),
  // matching credential-usage-poller.ts's rationale — don't hammer Anthropic
  // immediately on agent boot when the operator is debugging.
  schedule(intervalMs);

  log.info(
    { intervalMs, concurrency: REFRESH_CONCURRENCY },
    "credential-refresh-job started",
  );

  return {
    stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
      timer = null;
      log.info("credential-refresh-job stopped");
    },
    tickOnce: tick,
  };
}
