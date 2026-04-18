# API Audit — pick-db-writer-boundary

## Audit Date

2026-04-17

## Summary

Of the 6 nextjs files in scope, only **2** contain actual drizzle write calls:

- `apps/nextjs/src/app/actions/projects.ts` — 1 write call (`db.update`)
- `apps/nextjs/src/app/actions/settings.ts` — 2 write calls (`db.insert...onConflictDoUpdate`, `db.delete`)

The other 4 files are either read-only or already route through the agent HTTP client.

---

## File-by-File Findings

### `apps/nextjs/src/app/actions/sessions.ts`

**Status: NO WRITES — no new endpoint needed.**

Contains only reads (`db.select` from sessions, projects, agents, healthSnapshots) and calls
`client.startSession()` which already routes through `POST /session/start` on the agent.

### `apps/nextjs/src/app/actions/projects.ts`

**Status: 1 WRITE — needs `PATCH /projects/:id` on agent.**

| Operation | Table | Fields | Pre-condition |
|---|---|---|---|
| `db.update(projects).set(patch).where(eq(projects.id, id))` | `projects` | `tags` (string[] normalized), `description` (string) | Project must exist by UUID |

Existing agent endpoint: none. Agent's `GET /projects` aggregates sessions by projectId — it does
not own the `projects` table for writes today.

Endpoint needed: `PATCH /projects/:id`
- Body: `{ tags?: string[], description?: string }`
- Agent validates UUID format, applies the update, returns 200 `{ updated: true }` or 404.

### `apps/nextjs/src/app/actions/settings.ts`

**Status: 2 WRITES — needs `POST /agents` + `DELETE /agents/:id` on agent.**

| Operation | Table | Fields | Pre-condition |
|---|---|---|---|
| `db.insert(agentsTable).values({...}).onConflictDoUpdate(...)` (action=add) | `agents` | `id`, `name`, `host`, `port`, `enabled` | Upsert on `id` |
| `db.delete(agentsTable).where(eq(agentsTable.id, agent.name))` (action=remove) | `agents` | `id` = `agent.name` | None — idempotent delete |

Existing agent endpoint: none for writes. There is `GET /agent/self` (read).

Endpoints needed:
- `POST /agents` — body: `{ name: string, host: string, port: number }`, upserts into agents table
- `DELETE /agents/:id` — deletes agent record by id

### `apps/nextjs/src/app/api/projects/route.ts`

**Status: NO WRITES — no new endpoint needed.**

Contains only `GET` handler with reads (`db.select` with joins). No POST/PATCH/DELETE handler.

### `apps/nextjs/src/lib/projects.ts`

**Status: NO WRITES — no new endpoint needed.**

Pure helpers: `PROJECT_SELECT_FIELDS` constant and `buildCanonicalProjects()` aggregation
function. No DB calls at all — the `db` is passed in by callers.

### `apps/nextjs/src/lib/get-client.ts`

**Status: READ-ONLY — needs ReadOnlyDb migration, no new endpoint.**

`getAgentConfigs()` does `db.select().from(agents).where(eq(agents.enabled, true))` — read only.
`getClient()` creates an `AgentClient` from those configs. No writes.

Task: switch from `Db` to `ReadOnlyDb` (task 2.10).

---

## Endpoint Summary

| NextJS write site | Operation | Existing agent endpoint? | Endpoint needed |
|---|---|---|---|
| `actions/sessions.ts` | None (reads + `client.startSession()`) | `POST /session/start` exists | **None** |
| `actions/projects.ts` | `db.update(projects)` — tags + description | No | `PATCH /projects/:id` |
| `actions/settings.ts` | `db.insert(agentsTable)` upsert | No | `POST /agents` |
| `actions/settings.ts` | `db.delete(agentsTable)` | No | `DELETE /agents/:id` |
| `api/projects/route.ts` | None (GET only) | N/A | **None** |
| `lib/projects.ts` | None (pure helper, no DB calls) | N/A | **None** |
| `lib/get-client.ts` | None (read-only select) | N/A | **None** (ReadOnlyDb cast) |

## Task Implications

- **Task 2.2 (sessions endpoints)**: NO-OP — sessions.ts has zero writes.
- **Task 2.3 (projects endpoints)**: Add `PATCH /projects/:id` to agent.
- **Task 2.4 (settings endpoints)**: Add `POST /agents` + `DELETE /agents/:id` to agent.
- **Task 2.5 (convert sessions.ts)**: NO-OP — no writes to convert.
- **Task 2.6 (convert projects.ts)**: Convert `updateProject` to call `PATCH /projects/:id`.
- **Task 2.7 (convert settings.ts)**: Convert `saveAgentConfig` to call `POST /agents` / `DELETE /agents/:id`.
- **Task 2.8 (convert api/projects/route.ts)**: NO-OP — GET only, no writes.
- **Task 2.9 (convert lib/projects.ts)**: NO-OP — pure helpers, no DB calls.
- **Task 2.10 (get-client.ts ReadOnlyDb)**: Switch `Db` to `ReadOnlyDb`.
