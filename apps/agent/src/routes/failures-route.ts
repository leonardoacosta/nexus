/**
 * GET /failures — aggregated tool failure data.
 *
 * Split from operational.ts.
 */

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

export async function handleFailures(url: URL): Promise<Response> {
  const daysParam = url.searchParams.get("days");
  const days = daysParam ? parseInt(daysParam, 10) : 7;

  // The failure buffer is backed by the Rust agent's SQLite.
  // For now, return a stub response matching the expected shape.
  return new Response(
    JSON.stringify({
      period_days: days,
      total: 0,
      by_tool: {},
      by_project: {},
      top_errors: [],
      trend: {
        current: 0,
        previous: 0,
        direction: "flat",
      },
    }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );
}
