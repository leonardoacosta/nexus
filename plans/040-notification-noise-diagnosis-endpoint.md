# Plan 040: Add a self-service notification noise-diagnosis endpoint (noisiest titles / busiest hours)

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat 6796f8ab..HEAD -- apps/agent/src/routes/analytics.ts apps/agent/src/server-request-handler.ts`
> Expected: no output (empty diff). If either file changed since this plan
> was written, compare the "Current state" excerpts below against the live
> file before proceeding; on a real mismatch, treat it as a STOP condition.

## Status

- **Priority**: P2
- **Effort**: M
- **Risk**: LOW
- **Depends on**: none
- **Category**: dx (noise reduction — self-service diagnosis)
- **Planned at**: commit `6796f8ab`, 2026-07-13

## Why this matters

A noise-reduction audit of the notification/TTS system (`/improve` pass,
2026-07-13) found **no aggregation/rollup surface exists anywhere in the
stack**. `GET /notifications` (`apps/agent/src/routes/notifications.ts`) is a
flat newest-200 list with no filters. `GET /analytics/notifications`
(`apps/agent/src/routes/analytics.ts`) supports filtering + keyset pagination
but returns raw per-row data, not aggregates — and it has **zero consumers**
in `apps/swift` or `apps/web` (confirmed by grep). The Swift dashboard's
`NotificationsView` only supports sorting by Time/Project/Session — never by
title or frequency.

The result: answering "what's the noisiest recurring notification title" or
"what hour of the day fires the most TTS" required this audit to hand-roll
ad-hoc SQL directly against the production database. That's exactly the kind
of ongoing self-diagnosis Leo needs to keep tuning noise down over time
(alongside plans 039/041/042 from the same audit, which fix specific noise
sources but don't give Leo a way to *see* the next one as it emerges). This
plan adds one new endpoint, `GET /analytics/notifications/summary`, that
answers both questions with a `GROUP BY` query instead of a hand-written
script.

## Current state

- `apps/agent/src/routes/analytics.ts:1-28` — file header + imports. Current
  import line 14 (the one this plan extends):
  ```ts
  import { and, desc, eq, gte, or, lt, type SQL } from "drizzle-orm";
  ```
  This plan adds `sql` to that import list (Drizzle's raw-SQL-fragment
  helper, already used elsewhere in this repo for aggregates — see
  `apps/agent/src/routes/credentials/handlers-health-usage.ts:145-151` for
  the established `sql<number>\`COUNT(*)\`` pattern this plan follows).

- The existing `GET /analytics/notifications` handler
  (`handleAnalyticsNotifications`, same file, lines 200-350) is the closest
  sibling — same `hours` query-param convention (default 24, reject
  `<= 0`/`NaN`), same `jsonResponse`-via-inline-`new Response(...)` style,
  same `log.error(...)` + `500` catch-all pattern. Model the new handler's
  request-parsing and error-handling exactly on this one; do not invent a
  different validation style.

- `apps/agent/src/server-request-handler.ts` — route registration. The
  routes array (lines 193-200) currently reads:
  ```ts
  // Analytics
  { method: "GET", path: "/analytics/health" },
  { method: "GET", path: "/analytics/notifications" },
  { method: "GET", path: "/analytics/specs" },
  { method: "GET", path: "/analytics/credentials" },
  { method: "GET", path: "/analytics/git" },
  { method: "GET", path: "/analytics/lifecycle" },
  { method: "GET", path: "/analytics/cron" },
  ```
  The dispatch block (lines 610-623) currently reads:
  ```ts
  // ── Analytics routes ──────────────────────────────────────────────
  if (url.pathname === "/analytics/health" && request.method === "GET") {
    return handleAnalyticsHealth(db, url).then((r) => withCors(request, r)).catch((err) => {
      logger.error({ route: "/analytics/health", method: "GET", err }, "route handler failed");
      return withCors(request, new Response(JSON.stringify({ error: "internal error" }), { status: 500, headers: { "Content-Type": "application/json" } }));
    });
  }

  if (url.pathname === "/analytics/notifications" && request.method === "GET") {
    return handleAnalyticsNotifications(db, url).then((r) => withCors(request, r)).catch((err) => {
      logger.error({ route: "/analytics/notifications", method: "GET", err }, "route handler failed");
      return withCors(request, new Response(JSON.stringify({ error: "internal error" }), { status: 500, headers: { "Content-Type": "application/json" } }));
    });
  }
  ```
  Both the routes-array entry and a dispatch block, matching this exact
  shape, need a new entry for `/analytics/notifications/summary`.

- The import block bringing analytics handlers into
  `server-request-handler.ts` (around line 62, ends `} from "./routes/analytics";`)
  needs `handleAnalyticsNotificationsSummary` added to its named-import list.

- `apps/agent/src/routes/analytics.test.ts:215-264` — the existing
  live-PG-gated test suite for `handleAnalyticsNotifications`, which this
  plan's tests extend (same file, same `describe.skipIf(!hasPg)` block, same
  isolated-schema fixture):
  ```ts
  describe.skipIf(!hasPg)("handleAnalyticsNotifications (requires live PG)", () => {
    let adminClient: ReturnType<typeof createDb>["client"];
    let scopedClient: ReturnType<typeof createDb>["client"];
    let db: Db;

    beforeAll(async () => {
      const url = process.env.POSTGRES_URL!;
      const adminHandle = createDb(url);
      adminClient = adminHandle.client;

      await adminClient.unsafe(`CREATE SCHEMA "${AN_SCHEMA}"`);
      await adminClient.unsafe(`SET search_path TO "${AN_SCHEMA}", public`);
      await adminClient.unsafe(AN_DDL);

      const scopedHandle = createDb(url, {
        connection: { search_path: `"${AN_SCHEMA}",public` },
      });
      scopedClient = scopedHandle.client;
      db = scopedHandle.db;
    });

    afterAll(async () => { /* drops the scoped schema */ });

    beforeEach(async () => {
      // Truncate + reseed three rows across two projects and two statuses,
      // all inside the default 24h window: an-1 (foo, delivered), an-2 (foo,
      // suppressed), an-3 (bar, delivered).
      ...
    });

    it("?hours=24 returns all three seeded rows", async () => { ... });
    // ... more existing tests ...
  });
  ```
  `AN_SCHEMA` and `AN_DDL` are constants defined earlier in the same test
  file — reuse them, do not redefine a parallel schema/DDL pair.

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Agent typecheck | `pnpm --filter @nexus/agent typecheck` | exit 0 |
| Run the analytics test file (requires a reachable Postgres; skips gracefully otherwise) | `bun test apps/agent/src/routes/analytics.test.ts` | all pass (new tests included), or the live-PG describe block reports `skip` if `POSTGRES_URL` / live PG is unavailable — either is acceptable, a hard FAIL is not |
| Manual smoke test against the live dev agent (optional, only if the agent is already running locally) | `curl -s 'http://localhost:7400/analytics/notifications/summary?hours=336&limit=10' \| python3 -m json.tool` | valid JSON with `window_hours`, `by_title` (<=10 entries), `by_hour` (exactly 24 entries) |

## Suggested executor toolkit

- Reference the exact `sql<number>` aggregate pattern in
  `apps/agent/src/routes/credentials/handlers-health-usage.ts:143-159` before
  writing the GROUP BY queries — this repo already has an established
  Drizzle raw-aggregate convention; do not invent a different one.

## Scope

**In scope**:
- `apps/agent/src/routes/analytics.ts` — add the `sql` import, the
  `handleAnalyticsNotificationsSummary` handler, its supporting constants/
  types.
- `apps/agent/src/server-request-handler.ts` — add the import, the
  routes-array entry, and the dispatch block for the new route.
- `apps/agent/src/routes/analytics.test.ts` — add tests inside the existing
  `describe.skipIf(!hasPg)("handleAnalyticsNotifications (requires live PG)", ...)`
  block (reusing its `db`/`scopedClient`/`beforeEach` fixture), plus a small
  input-validation describe block alongside the existing
  `"handleAnalyticsNotifications input validation (no DB)"` block.

**Out of scope** (do NOT touch, even though they look related):
- Swift dashboard UI (`NotificationsView.swift`) — building a UI for this
  data is a separate, larger follow-up that requires a Mac build to verify
  (see Maintenance notes). This plan is backend-only; verify via `curl`, not
  a Swift screenshot.
- `GET /notifications` or `GET /analytics/notifications` (the existing flat
  list endpoints) — leave them exactly as they are; this plan adds a new,
  separate endpoint rather than modifying either.
- Any change to how notifications are inserted, deduped, or delivered —
  this plan is read-only reporting over the existing `notifications` table.
- Retention/pruning of the `notifications` table — a separate, unplanned
  concern (noted in the original audit as low-urgency at current volume).

## Git workflow

- Branch: none required — single-commit ad-hoc change per this repo's
  convention (`~/.claude/rules/BEADS.md` § Session Close Protocol, "ad-hoc
  lane").
- Commit message style (conventional commits, matches recent history):
  `feat(agent): add /analytics/notifications/summary noise-diagnosis endpoint`
- Stage only the in-scope files (plus `.beads/` if applicable) — do not run
  `git add .` or `git add -A` in this shared tree.
- Do NOT push unless the operator instructed it.

## Steps

### Step 1: Add the `sql` import

In `apps/agent/src/routes/analytics.ts`, change:
```ts
import { and, desc, eq, gte, or, lt, type SQL } from "drizzle-orm";
```
to:
```ts
import { and, desc, eq, gte, or, lt, sql, type SQL } from "drizzle-orm";
```

**Verify**: `pnpm --filter @nexus/agent typecheck` → exit 0.

### Step 2: Add the summary handler

Append this to the end of `apps/agent/src/routes/analytics.ts` (after the
existing `handleAnalyticsCron` function):

```ts
// ---------------------------------------------------------------------------
// GET /analytics/notifications/summary
// ---------------------------------------------------------------------------

/** Default number of top-title rows returned. */
const SUMMARY_DEFAULT_LIMIT = 20;
/** Hard maximum for ?limit= on the summary endpoint. */
const SUMMARY_MAX_LIMIT = 100;

interface NotificationTitleSummaryRow {
  title: string;
  project: string | null;
  count: number;
}

interface NotificationHourSummaryRow {
  hour: number;
  count: number;
}

/**
 * GET /analytics/notifications/summary?hours=N&limit=L
 *
 * Self-service noise-diagnosis view (noise-reduction audit, 2026-07-13):
 * answers "what's noisiest" and "what hour is loudest" without ad-hoc SQL.
 *
 * - `by_title`: top `limit` (title, project) pairs by notification count in
 *   the window, ordered descending by count.
 * - `by_hour`: all 24 hours-of-day (server local time, via Postgres
 *   `EXTRACT(HOUR FROM created_at)`), zero-filled for any hour with no
 *   notifications in the window — the response always has exactly 24
 *   entries regardless of data sparsity.
 *
 * Defaults to a 24h window (`hours` param, same convention as
 * `/analytics/notifications`); pass a wider window (e.g. `?hours=336` for
 * 14 days) to reproduce a longer-range noise audit.
 */
export async function handleAnalyticsNotificationsSummary(
  db: Db,
  url: URL,
): Promise<Response> {
  const hoursParam = url.searchParams.get("hours");
  const limitParam = url.searchParams.get("limit");

  const hours = hoursParam ? Number(hoursParam) : 24;
  if (Number.isNaN(hours) || hours <= 0) {
    return new Response(
      JSON.stringify({ error: "hours must be a positive number" }),
      { status: 400, headers: { "Content-Type": "application/json" } },
    );
  }

  let limit = SUMMARY_DEFAULT_LIMIT;
  if (limitParam !== null) {
    const parsed = Number(limitParam);
    if (!Number.isFinite(parsed) || parsed <= 0 || parsed > SUMMARY_MAX_LIMIT) {
      return new Response(
        JSON.stringify({ error: `limit must be between 1 and ${SUMMARY_MAX_LIMIT}` }),
        { status: 400, headers: { "Content-Type": "application/json" } },
      );
    }
    limit = Math.floor(parsed);
  }

  const cutoff = new Date(Date.now() - hours * 3600_000);

  try {
    const titleRows = await db
      .select({
        title: notificationsTable.title,
        project: notificationsTable.project,
        count: sql<number>`COUNT(*)`,
      })
      .from(notificationsTable)
      .where(gte(notificationsTable.createdAt, cutoff))
      .groupBy(notificationsTable.title, notificationsTable.project)
      .orderBy(desc(sql`COUNT(*)`))
      .limit(limit);

    const hourRows = await db
      .select({
        hour: sql<number>`EXTRACT(HOUR FROM ${notificationsTable.createdAt})::int`,
        count: sql<number>`COUNT(*)`,
      })
      .from(notificationsTable)
      .where(gte(notificationsTable.createdAt, cutoff))
      .groupBy(sql`EXTRACT(HOUR FROM ${notificationsTable.createdAt})::int`);

    const hourMap = new Map<number, number>();
    for (const r of hourRows) hourMap.set(Number(r.hour), Number(r.count));
    const by_hour: NotificationHourSummaryRow[] = Array.from({ length: 24 }, (_, hour) => ({
      hour,
      count: hourMap.get(hour) ?? 0,
    }));

    const by_title: NotificationTitleSummaryRow[] = titleRows.map((r) => ({
      title: r.title,
      project: r.project,
      count: Number(r.count),
    }));

    return new Response(
      JSON.stringify({ window_hours: hours, by_title, by_hour }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  } catch (err) {
    log.error(
      { err: err instanceof Error ? err.message : String(err) },
      "analytics/notifications/summary query failed",
    );
    return new Response(
      JSON.stringify({ error: "internal error" }),
      { status: 500, headers: { "Content-Type": "application/json" } },
    );
  }
}
```

**Verify**: `pnpm --filter @nexus/agent typecheck` → exit 0.

### Step 3: Register the route

In `apps/agent/src/server-request-handler.ts`:

1. Add `handleAnalyticsNotificationsSummary` to the named imports from
   `"./routes/analytics"` (the import block ending around line 62).
2. In the routes array, add a new line immediately after
   `{ method: "GET", path: "/analytics/notifications" },`:
   ```ts
   { method: "GET", path: "/analytics/notifications/summary" },
   ```
3. In the dispatch block, add a new `if` immediately after the existing
   `/analytics/notifications` block (after its closing `}` around line 623):
   ```ts
   if (url.pathname === "/analytics/notifications/summary" && request.method === "GET") {
     return handleAnalyticsNotificationsSummary(db, url).then((r) => withCors(request, r)).catch((err) => {
       logger.error({ route: "/analytics/notifications/summary", method: "GET", err }, "route handler failed");
       return withCors(request, new Response(JSON.stringify({ error: "internal error" }), { status: 500, headers: { "Content-Type": "application/json" } }));
     });
   }
   ```

**Verify**: `pnpm --filter @nexus/agent typecheck` → exit 0.

### Step 4: Add input-validation tests (no DB required)

In `apps/agent/src/routes/analytics.test.ts`, add a new describe block
alongside the existing `"handleAnalyticsNotifications input validation (no DB)"`
block (around line 616), importing the new handler at the top of the file's
existing import from `"./analytics"`:

```ts
describe("handleAnalyticsNotificationsSummary input validation (no DB)", () => {
  it("rejects hours=0", async () => {
    const url = new URL("http://localhost/analytics/notifications/summary?hours=0");
    const response = await handleAnalyticsNotificationsSummary(null as never, url);
    expect(response.status).toBe(400);
  });

  it("rejects limit=0", async () => {
    const url = new URL("http://localhost/analytics/notifications/summary?limit=0");
    const response = await handleAnalyticsNotificationsSummary(null as never, url);
    expect(response.status).toBe(400);
  });

  it("rejects limit > 100", async () => {
    const url = new URL("http://localhost/analytics/notifications/summary?limit=101");
    const response = await handleAnalyticsNotificationsSummary(null as never, url);
    expect(response.status).toBe(400);
  });
});
```

**Verify**: `bun test apps/agent/src/routes/analytics.test.ts -t "input validation"` → all pass.

### Step 5: Add live-PG aggregation tests

Inside the existing `describe.skipIf(!hasPg)("handleAnalyticsNotifications (requires live PG)", () => { ... })`
block, add new `it()` blocks that insert extra rows on top of the
`beforeEach` fixture (3 rows: `an-1`/foo/delivered, `an-2`/foo/suppressed,
`an-3`/bar/delivered) to create a real duplicate-title scenario, then assert
on the grouped output:

```ts
it("summary: by_title groups repeated (title, project) pairs and orders by count desc", async () => {
  // Insert 2 more "Build OK foo" rows so that title now has 3 occurrences
  // total (an-1 + these 2), while "Build OK bar" and "Build dropped foo"
  // stay at 1 each.
  const now = new Date();
  await adminClient.unsafe(`
    INSERT INTO "${AN_SCHEMA}".notifications
      ("id", "channel", "title", "body", "project", "status", "created_at")
    VALUES
      ('an-4', 'desktop', 'Build OK foo', 'foo body 2', 'foo', 'delivered', '${now.toISOString()}'),
      ('an-5', 'desktop', 'Build OK foo', 'foo body 3', 'foo', 'delivered', '${now.toISOString()}')
  `);

  const url = new URL("http://localhost/analytics/notifications/summary?hours=24");
  const response = await handleAnalyticsNotificationsSummary(db, url);
  expect(response.status).toBe(200);

  const body = (await response.json()) as {
    window_hours: number;
    by_title: Array<{ title: string; project: string | null; count: number }>;
    by_hour: Array<{ hour: number; count: number }>;
  };
  expect(body.window_hours).toBe(24);
  expect(body.by_title[0]).toEqual({ title: "Build OK foo", project: "foo", count: 3 });
  expect(body.by_title).toHaveLength(3); // 3 distinct (title, project) pairs total
  expect(body.by_hour).toHaveLength(24); // always exactly 24 entries
  // All 5 seeded rows share the same current hour in this test — that
  // hour's count must be exactly 5, every other hour must be 0.
  const nonZero = body.by_hour.filter((h) => h.count > 0);
  expect(nonZero).toHaveLength(1);
  expect(nonZero[0]!.count).toBe(5);
});

it("summary: respects ?limit=", async () => {
  const url = new URL("http://localhost/analytics/notifications/summary?hours=24&limit=1");
  const response = await handleAnalyticsNotificationsSummary(db, url);
  expect(response.status).toBe(200);

  const body = (await response.json()) as { by_title: unknown[] };
  expect(body.by_title).toHaveLength(1);
});
```

**Verify**: `bun test apps/agent/src/routes/analytics.test.ts -t "summary"` →
all pass. If no live Postgres is reachable, this whole describe block
reports `skip` (per the file's existing `describe.skipIf(!hasPg)` guard) —
that is an acceptable "cannot verify on this machine" outcome, not a
failure; rely on Step 4's no-DB tests in that case.

## Test plan

- Step 4: 3 new input-validation tests (no DB), modeled on the existing
  `"handleAnalyticsNotifications input validation (no DB)"` describe block.
- Step 5: 2 new live-PG tests inside the existing
  `describe.skipIf(!hasPg)("handleAnalyticsNotifications (requires live PG)", ...)`
  block, reusing its schema/fixture setup.
- Verification: `bun test apps/agent/src/routes/analytics.test.ts` → all
  pass (existing tests + 5 new ones), or the live-PG block reports skip if
  no Postgres is reachable.

## Done criteria

Machine-checkable. ALL must hold:

- [ ] `pnpm --filter @nexus/agent typecheck` exits 0
- [ ] `bun test apps/agent/src/routes/analytics.test.ts` → all pass (or the live-PG describe block reports skip, never a hard fail)
- [ ] `curl -s 'http://localhost:7400/analytics/notifications/summary?hours=24' | python3 -c "import json,sys; d=json.load(sys.stdin); assert 'by_title' in d and 'by_hour' in d and len(d['by_hour'])==24"` succeeds without an assertion error, IF the local agent is running (skip this specific check with a note if it isn't — do not start the agent solely to run this check)
- [ ] `grep -n "handleAnalyticsNotificationsSummary" apps/agent/src/server-request-handler.ts` finds at least 2 matches (import + dispatch)
- [ ] No files outside the in-scope list are modified (`git status --short`)
- [ ] `plans/README.md` status row for plan 040 updated to DONE

## STOP conditions

Stop and report back (do not improvise) if:

- The routes array or dispatch block in `server-request-handler.ts` doesn't
  match the "Current state" excerpt above (line numbers may have shifted,
  but the exact string/shape should still be findable via
  `grep -n "/analytics/notifications"` — if the shape itself differs
  materially, the file has drifted more than expected).
- `pnpm --filter @nexus/agent typecheck` fails with an error about `sql` or
  `groupBy` not being valid on this Drizzle version — check
  `packages/db/package.json`'s `drizzle-orm` version against
  `handlers-health-usage.ts`'s working usage before assuming your code is
  wrong.
- The live-PG test in Step 5 returns an `hour` value that doesn't match
  `now.getHours()` in the test's own timezone — this would mean
  `EXTRACT(HOUR FROM created_at)` is reading a different timezone than
  expected (e.g. the column is `timestamptz` and the DB session timezone
  differs from the test runner's); if so, report the actual vs. expected
  hour rather than adjusting the test to match unexplained behavior.

## Maintenance notes

- This is a backend-only endpoint. A future Swift dashboard feature (a
  "Noisiest" tab, or a bar chart) can consume it directly — no schema change
  needed on that side, since this endpoint reads the existing `notifications`
  table read-only.
- If notification volume grows enough that the `GROUP BY title, project`
  query becomes slow (unlikely at this repo's current few-hundred/day scale,
  but worth a note), an index on `(created_at, title, project)` would help;
  not added here since it's unwarranted at current scale (premature
  optimization).
- If plans 041 (rate-throttle) or 042 (quiet-hours gate) from this same audit
  wave land after this one, consider whether their new behavior (held/
  coalesced summaries, quiet-hours-suppressed rows) should be filtered out of
  `by_title`/`by_hour` so the diagnosis view reflects what Leo actually
  *hears* rather than raw insert volume — that's a follow-up refinement, not
  built here (this plan reports raw table volume, consistent with what the
  original audit's own ad-hoc SQL measured).
