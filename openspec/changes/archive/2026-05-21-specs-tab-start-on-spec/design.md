# Design: specs-tab-start-on-spec

## Schema

`packages/db/src/schema/specSessions.ts` mirrors the `pgTable` + `index`
conventions of `cronRuns.ts` (just shipped in `adopt-reaper-into-nx-cron`):

```ts
import { index, pgTable, text, timestamp } from "drizzle-orm/pg-core";

export const specSessions = pgTable(
  "spec_sessions",
  {
    id: text("id").primaryKey().generatedAlwaysAsIdentity(),
    project: text("project").notNull(),
    specName: text("spec_name").notNull(),
    sessionId: text("session_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => ({
    specIdx: index("spec_sessions_spec_idx").on(t.project, t.specName),
    sessionIdx: index("spec_sessions_session_idx").on(t.sessionId),
  }),
);

export type SpecSession = typeof specSessions.$inferSelect;
export type NewSpecSession = typeof specSessions.$inferInsert;
```

Migration: drizzle-kit generates `packages/db/drizzle/0034_add_spec_sessions.sql`.
The DB phase agent (db-engineer) follows the same trim-snapshot routine the
adopt-reaper migration used because the drizzle-kit auto-snapshot still has
the pre-existing desync from custom-SQL migrations (tracked as a P3 bug,
`nx-XXX`). Trim the .sql to only the new table + 2 indices.

## Endpoint Wiring

### POST /session/start (extension)

`apps/agent/src/routes/sessions.ts` (or wherever the current handler lives —
check `apps/agent/src/server-request-handler.ts` routing). Accept optional
`spec_slug: string` in the body. After successful tmux spawn:

```ts
if (body.spec_slug) {
  try {
    const linkResult = await linkSpecToSession({
      db,
      project: body.project,
      specSlug: body.spec_slug,
      sessionId: sessionName,
    });
    return Response.json({
      session_name: sessionName,
      started: true,
      spec_linked: linkResult.linked,
      spec_link_error: linkResult.error,
    });
  } catch (err) {
    // Linking failure must NOT roll back the tmux spawn. Log and degrade.
    logger.warn({ err, spec_slug: body.spec_slug }, "spec link failed");
    return Response.json({
      session_name: sessionName,
      started: true,
      spec_linked: false,
      spec_link_error: "internal error",
    });
  }
}
```

Helper lives in `apps/agent/src/services/session-spec-link.ts`:

```ts
export async function linkSpecToSession(opts: {
  db: NexusDB;
  project: string;
  specSlug: string;
  sessionId: string;
}): Promise<{ linked: boolean; error?: string }> {
  const specDir = resolveSpecDir(opts.project, opts.specSlug);
  // resolveSpecDir checks openspec/changes/<slug>/ then archive/*-<slug>/
  if (!specDir) {
    return { linked: false, error: "spec not found" };
  }
  await opts.db.insert(specSessions).values({
    project: opts.project,
    specName: opts.specSlug,
    sessionId: opts.sessionId,
  });
  return { linked: true };
}
```

### GET /specs/:project/:name/sessions

New file: `apps/agent/src/routes/specs/handlers-sessions.ts`. Mirrors the
`handlers-status.ts` pattern. Query joins `spec_sessions` against the live
sessions registry (`sessions` table) to compute `active`:

```ts
const rows = await db
  .select({
    id: specSessions.id,
    sessionId: specSessions.sessionId,
    createdAt: specSessions.createdAt,
    active: sql<boolean>`${sessions.id} IS NOT NULL`,
  })
  .from(specSessions)
  .leftJoin(sessions, eq(sessions.id, specSessions.sessionId))
  .where(
    and(
      eq(specSessions.project, project),
      eq(specSessions.specName, specName),
    ),
  )
  .orderBy(desc(specSessions.createdAt));
```

Route registration in `apps/agent/src/server-routes-specs.ts`. The literal
path segment `sessions` must match BEFORE the catch-all
`/specs/:project/:name/:file` so it doesn't get treated as a raw markdown
file (the matcher chain already enforces this ordering — see
`commands-send-text` vs `commands/:name` precedent in `server-routes-specs.ts`).

### PATCH /specs/:project/:name/status

New file: `apps/agent/src/routes/specs/handlers-status.ts`. Reuses the
`splice-frontmatter` logic from `~/.claude/scripts/bin/triage` (cited in
proposal.md § Risk). Body must be `{ status: "draft" | "approved" }`.
Resolves the user email from `git config user.email` via a subprocess;
falls back to `$USER`. Writes via `.tmp + fs.renameSync` (POSIX-atomic
on same filesystem). After the write succeeds, emit on the existing
`/specs/events` SSE bus.

## Swift UI

### SpecsView changes

`apps/swift/nexus-mac/Sources/Dashboard/SpecsView.swift` currently has
an HSplitView: row list on the left, SpecDetailView on the right. The
right pane becomes an enum:

```swift
enum RightPaneState: Equatable {
    case spec(SpecSummary)
    case pty(sessionId: String, fromSpec: SpecSummary)
    case empty
}

@State private var rightPane: RightPaneState = .empty
```

The proposal row gets a `Start Session` button. Click handler:

1. Optimistically set `rightPane = .pty(sessionId: "starting...", fromSpec: spec)`
2. Call `nexusClient.startSession(project: spec.project, path: projectPath, specSlug: spec.name)`
3. On success: replace the placeholder sessionId with the real one
4. On error: revert `rightPane` to `.spec(spec)`, surface a banner

When the PTY pane is shown, a small back-arrow button in the header
flips `rightPane` to `.spec(fromSpec)`. The PTY view is the same
`PtyViewer` already shipped on the Sessions tab — same SwiftTerm
delegate, same close button, same connect-window watchdog.

### SpecDetailView changes

Add a status pill button at the top of the metadata pane. Three states:
`draft` (gray), `approved` (green), `archived` (blue, read-only).

Click → confirm dialog → `PATCH /specs/:project/:name/status { status }`.
On 200, optimistically update the pill; SSE will reconcile if there's
drift. On 409 archived: dialog disabled.

Below the pill: a key/value list rendering `frontmatter: Record<string, string>`
verbatim, with keys left-aligned monospace and values right-aligned. No
free-text editing — just visibility.

## Test Strategy

DB phase: drizzle-kit migration applies cleanly against the real PG scratch
schema (same pattern as `reaper-persistence.test.ts` — no mocks).

API phase: `apps/agent/src/services/session-spec-link.test.ts` covers
link / unknown-spec / archive-spec paths. The `PATCH status` handler gets
unit tests covering each scenario from the spec (draft→approved,
approved→draft, invalid status, archived rejection). Real-FS atomic
writes — use `os.tmpdir()` scratch dirs, not mocks.

UI phase: `SpecsViewTests.swift` (mirrors `SessionRowTests.swift`
convention) covers the right-pane enum transitions, the optimistic
state machine, and the SSE-driven status reconciliation. Tests use
fakes for `NexusClient` (already a protocol-shaped abstraction).

E2E: full flow test — start the agent, POST /session/start with
spec_slug, verify the row in spec_sessions, GET /specs/.../sessions
returns it, PATCH status flips frontmatter on disk and emits SSE.
Gated behind `NEXUS_RUN_LIVE_E2E_TESTS=1` per project test convention.
