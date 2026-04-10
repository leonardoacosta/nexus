/**
 * GET /cron — cron job status and last run times.
 *
 * Split from operational.ts.
 */

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

export function handleCron(): Response {
  // Return the known cron jobs and their schedules.
  // Actual last_run tracking is done by the CronService which runs in-process.
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
      },
    }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );
}
