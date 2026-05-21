/**
 * GET /cron — cron job status and last run times.
 *
 * For the `reaper` job, last_run / last_status / last_log are read from the
 * `cron_runs` table (adopt-reaper-into-nx-cron). The `maintain` and `drift`
 * jobs do not currently persist runs — kept as `null` until they do.
 */

import type { Db } from "@nexus/db";
import { cronRuns } from "@nexus/db";
import { desc, eq } from "drizzle-orm";
import { createLogger } from "@nexus/core/node";

const log = createLogger("agent:routes:cron");

// ---------------------------------------------------------------------------
// Helper — most recent cron_runs row for a given job
// ---------------------------------------------------------------------------

interface JobSummary {
  schedule: string;
  last_run: string | null;
  last_status: string | null;
  last_log: string | null;
}

async function latestReaperSummary(db: Db): Promise<JobSummary> {
  const base: JobSummary = {
    schedule: "weekly @ Sun 03:00",
    last_run: null,
    last_status: null,
    last_log: null,
  };

  try {
    const rows = await db
      .select({
        timestamp: cronRuns.timestamp,
        status: cronRuns.status,
        details: cronRuns.details,
      })
      .from(cronRuns)
      .where(eq(cronRuns.job, "reaper"))
      .orderBy(desc(cronRuns.timestamp))
      .limit(1);

    const row = rows[0];
    if (!row) return base;

    // `details.logPath` is the bash core's `LOG_FILE` path written by the
    // wrapper. Stored as `jsonb` so we narrow defensively.
    let logPath: string | null = null;
    if (row.details && typeof row.details === "object" && !Array.isArray(row.details)) {
      const lp = (row.details as Record<string, unknown>).logPath;
      if (typeof lp === "string") logPath = lp;
    }

    return {
      schedule: base.schedule,
      last_run: row.timestamp.toISOString(),
      last_status: row.status,
      last_log: logPath,
    };
  } catch (err) {
    log.warn(
      { error: err instanceof Error ? err.message : String(err) },
      "GET /cron: failed to load latest reaper run — returning null fields",
    );
    return base;
  }
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

/**
 * Handle GET /cron.
 *
 * `db` is optional so the route can still respond (with null reaper fields)
 * when the agent boots without a database. When `db` is present, the route
 * reads the most recent `cron_runs` row for `job="reaper"`.
 */
export async function handleCron(db?: Db): Promise<Response> {
  const reaper = db
    ? await latestReaperSummary(db)
    : ({
        schedule: "weekly @ Sun 03:00",
        last_run: null,
        last_status: null,
        last_log: null,
      } satisfies JobSummary);

  return new Response(
    JSON.stringify({
      jobs: {
        maintain: {
          schedule: "daily @ 00:17",
          last_run: null,
          last_status: null,
          last_log: null,
        },
        drift: {
          schedule: "weekly @ Sun 09:00",
          last_run: null,
          last_status: null,
          last_log: null,
        },
        reaper,
      },
    }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );
}
