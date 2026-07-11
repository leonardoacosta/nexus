/**
 * statusline-usage-file — persist the ACTIVE credential's freshly-polled
 * 5h / 7d usage to a shared JSON cache file that `nexus-statusline` (and
 * cc-tmux's `usage.py`) read instead of calling Anthropic's
 * `/api/oauth/usage` themselves.
 *
 * Spec: openspec/changes/cc-tmux-session-usage-bars (task 1.1) — usage
 * consolidation. `nexus-agent`'s poller is made the SOLE caller of the
 * Anthropic usage endpoint; this helper fans the polled snapshot out to one
 * more sink (the file `nexus-statusline` already cached from) so the
 * statusline stops hitting Anthropic and the uncoordinated 429s stop.
 *
 * The written shape MUST match `nexus-statusline`'s existing `CachedUsage`
 * reader byte-for-byte:
 *   { fetched_at: number, data: { five_hour?: { utilization, resets_at? },
 *                                 seven_day?: { utilization, resets_at? } } }
 * where `utilization` is a 0–100 percentage (the reader does
 * `Math.round(utilization)` / `100 - utilization`).
 *
 * Invariant: fail-soft. Every failure mode (no active fingerprint, no row,
 * no usage data, unwritable file) logs and returns — never throws into the
 * poller tick.
 */

import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import type { Db } from "@nexus/db";
import { credentials } from "@nexus/db";
import { desc, eq } from "drizzle-orm";
import { createLogger } from "@nexus/core/node";

import { getActiveCredentialSnapshot } from "../credentials/active-credential-watcher";

const log = createLogger("agent:services:statusline-usage-file");

/** Matches nexus-statusline's `CachedUsage` reader (apps/nexus-statusline/src/index.ts). */
interface UsagePeriod {
  utilization: number;
  resets_at?: string;
}
interface UsageResponse {
  five_hour?: UsagePeriod;
  seven_day?: UsagePeriod;
}
interface CachedUsage {
  fetched_at: number;
  data: UsageResponse;
}

/** Same path nexus-statusline's `usageCachePath()` reads from. */
function usageCachePath(): string {
  return join(homedir(), ".claude", "scripts", "state", "usage-cache.json");
}

/** used/limit → 0–100 percentage; 0 when the window has no limit. */
function utilizationPct(used: number | null, limit: number | null): number {
  if (!limit || limit <= 0) return 0;
  return ((used ?? 0) / limit) * 100;
}

/** Build one `UsagePeriod` when the window has any data, else `undefined`. */
function toPeriod(
  used: number | null,
  limit: number | null,
  resetAt: Date | null,
): UsagePeriod | undefined {
  if (used === null && limit === null) return undefined;
  const period: UsagePeriod = { utilization: utilizationPct(used, limit) };
  if (resetAt) period.resets_at = resetAt.toISOString();
  return period;
}

/**
 * Write the active credential's polled 5h/7d usage to `usage-cache.json`.
 *
 * Intended to be called from the credential usage poller's `onTickComplete`
 * (each tick persists fresh usage to the `credentials` row first; this reads
 * that row back and mirrors it to the file). Fail-soft on every path.
 */
export async function writeStatuslineUsageFile(db: Db): Promise<void> {
  try {
    const fingerprint = getActiveCredentialSnapshot().fingerprint;
    if (!fingerprint) {
      log.debug("no active credential fingerprint — skipping usage-cache write");
      return;
    }

    // A fingerprint can front multiple duplicate rows; take the most-recently
    // polled one so the file reflects the freshest snapshot for this account.
    const [row] = await db
      .select({
        usage5hUsed: credentials.usage5hUsed,
        usage5hLimit: credentials.usage5hLimit,
        usage5hResetAt: credentials.usage5hResetAt,
        usage7dUsed: credentials.usage7dUsed,
        usage7dLimit: credentials.usage7dLimit,
        usage7dResetAt: credentials.usage7dResetAt,
        usagePolledAt: credentials.usagePolledAt,
      })
      .from(credentials)
      .where(eq(credentials.fingerprint, fingerprint))
      .orderBy(desc(credentials.usagePolledAt))
      .limit(1);

    if (!row || !row.usagePolledAt) {
      log.debug(
        { fingerprint },
        "active credential row has no polled usage yet — skipping usage-cache write",
      );
      return;
    }

    const data: UsageResponse = {};
    const fiveHour = toPeriod(row.usage5hUsed, row.usage5hLimit, row.usage5hResetAt);
    const sevenDay = toPeriod(row.usage7dUsed, row.usage7dLimit, row.usage7dResetAt);
    if (fiveHour) data.five_hour = fiveHour;
    if (sevenDay) data.seven_day = sevenDay;

    if (!data.five_hour && !data.seven_day) {
      log.debug({ fingerprint }, "no parseable usage windows — skipping usage-cache write");
      return;
    }

    const payload: CachedUsage = {
      fetched_at: Math.floor(Date.now() / 1000),
      data,
    };

    const path = usageCachePath();
    // Atomic write (temp + rename) so a concurrent statusline render never
    // reads a half-written file. 0o600 matches the reader's own cache mode.
    const tmp = `${path}.tmp.${process.pid}`;
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(tmp, JSON.stringify(payload), { mode: 0o600 });
    renameSync(tmp, path);

    log.debug({ fingerprint }, "wrote usage-cache.json from active credential");
  } catch (err) {
    log.warn(
      { err: err instanceof Error ? err.message : String(err) },
      "writeStatuslineUsageFile failed (non-fatal)",
    );
  }
}
