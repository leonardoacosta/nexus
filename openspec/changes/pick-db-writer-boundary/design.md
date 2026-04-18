# Design: pick-db-writer-boundary

## Decision

**Adopt Option A: `apps/nextjs` becomes a pure HTTP client of `apps/agent` for writes.** The dashboard may still read directly from Postgres, but only through a narrowed `ReadOnlyDb` type exported from `@nexus/db/readonly`. All mutations originating from the dashboard route through the agent HTTP API.

This matches the original peer-to-peer design intent: the agent is the single source of truth for ingest and canonical state on each machine. The dashboard is a read-and-orchestration UI, not a co-equal writer. Letting both apps mutate the same tables is a slow-burn correctness hazard — Option A removes it without inverting the agent's role.

## Trade-offs

### Option A: Dashboard as pure HTTP client of agent (RECOMMENDED)

**Pros:**
- Matches the original p2p design intent — agent owns ingest, dashboard observes.
- Single source of truth for write-side invariants (the agent can validate, dedupe, queue, etc.).
- Schema migrations only break one app at a time — the agent's wire format insulates the dashboard from internal schema changes.
- Agent can cache, transform, or aggregate before serving — opens the door to read-side optimizations later.
- Easier to enforce — ESLint rule on `Db` imports in `apps/nextjs/` is a one-line ban.

**Cons:**
- Higher request latency for mutations: HTTP hop instead of direct query (10–50ms on Tailnet).
- Need to expose more endpoints in the agent — current surface focuses on session lifecycle, not project/settings CRUD.
- Server actions in nextjs become HTTP clients — slightly more boilerplate, harder to share types unless we rely on the `unify-session-credential-types` work.

### Option B: `@nexus/db` only-writer, agent demoted to read API

**Pros:**
- Less HTTP plumbing — server actions can run direct DB writes (lower latency).
- No need to grow the agent's HTTP surface.

**Cons:**
- **Inverts the agent's role.** Today the agent is the canonical ingest/state owner; this would demote it to a read replica frontend.
- **Doesn't fix the "schema migration breaks both" problem** — the agent still reads the schema, so any breaking schema change still requires coordinated deploys.
- Read/write split is harder to enforce in code review — both sides import `@nexus/db` and the boundary lives in convention, not types.
- Agent can no longer apply business rules to writes (validation, dedup, idempotency keys) without splitting the writer logic.

### Decision rationale

The audit framed the dual-writer problem as a correctness hazard with type-system invisibility. Option A solves both: writes funnel through one process (correctness), and the `ReadOnlyDb` type makes the boundary compile-checked (visibility). Option B trades the better correctness story for marginal latency wins on a non-hot path (server actions are already async and user-blocking). Pick A.

## ReadOnlyDb implementation

The narrowed type lives in `packages/db/src/readonly.ts` and is published via a new `./readonly` subpath export.

```typescript
// packages/db/src/readonly.ts
import type { Db } from "./client";

/**
 * A narrowed view of `Db` that exposes only read operations.
 * Use this in apps/nextjs to ensure no write paths can compile.
 */
export type ReadOnlyDb = Omit<Db, "insert" | "update" | "delete" | "execute" | "transaction">;

/**
 * Runtime guard for tests — verify a Db instance has been narrowed.
 * In production, the type system enforces this; this helper exists for
 * defense-in-depth in test fixtures.
 */
export function asReadOnly(db: Db): ReadOnlyDb {
  return db as ReadOnlyDb;
}
```

The omitted method names are drizzle-orm's mutation surface: `insert`, `update`, `delete`, `execute` (for raw SQL), and `transaction` (which wraps writes). `select`, `query`, and the relational query API remain accessible.

`packages/db/package.json` gains:

```json
"./readonly": {
  "types": "./src/readonly.ts",
  "default": "./src/readonly.ts"
}
```

The dashboard then imports as:

```typescript
import type { ReadOnlyDb } from "@nexus/db/readonly";
```

The runtime `db` instance is still constructed via `createDb()` — `ReadOnlyDb` is purely a type-level narrowing. To enforce the runtime guard in `apps/nextjs/src/lib/get-client.ts`, cast through `asReadOnly()` so any future direct `.insert()` call is a type error at the import site, not a runtime surprise.

## Migration strategy

The 8 nextjs files break into two complexity tiers.

### Tier 1: Read-only conversions (low complexity)

These already only read; switch them to `ReadOnlyDb`-typed clients.

| File | Today | After |
| ---- | ----- | ----- |
| `apps/nextjs/src/lib/get-client.ts` | imports `Db` | imports `ReadOnlyDb`, returns narrowed client |
| `apps/nextjs/src/lib/projects.ts` | imports schema tables for read joins | unchanged imports, but the `db` parameter it consumes is `ReadOnlyDb` |

### Tier 2: Write conversions (medium complexity)

Each becomes an `await fetch(...)` against the agent. Group by domain:

| File | Mutations | Agent endpoints needed |
| ---- | --------- | ---------------------- |
| `apps/nextjs/src/app/actions/sessions.ts` | `startSession` already calls agent — no DB writes today; verify. Other actions in the file may need migration if writes were added. | None new (verify). |
| `apps/nextjs/src/app/actions/projects.ts` | project CRUD writes | `POST /projects`, `PATCH /projects/:id`, `DELETE /projects/:id` |
| `apps/nextjs/src/app/actions/settings.ts` | agent + settings table writes | `POST /agents`, `PATCH /agents/:id`, `PATCH /settings` |
| `apps/nextjs/src/app/api/projects/route.ts` | project writes via API route | same as `actions/projects.ts` — share helper |

### Tier 3: Enforcement

After all migrations land:

- Add an ESLint rule (custom or via `no-restricted-imports`) banning `import { Db } from "@nexus/db"` and the named schema tables from any file under `apps/nextjs/`.
- Allowlist `ReadOnlyDb` and the named query helpers explicitly.
- Add a unit test that imports `ReadOnlyDb` and asserts `// @ts-expect-error` on `.insert()` / `.update()` / `.delete()` calls.

### Sequencing

1. Land `ReadOnlyDb` export (Tasks 1.1–1.2) — additive, no breakage.
2. Audit + add agent endpoints (Tasks 2.1–2.4) — additive, no breakage.
3. Convert nextjs files in tier order: 1 then 2 (Tasks 2.5–2.10).
4. Flip the ESLint rule (Task 2.11) — last, after all imports are clean.
5. E2E + unit tests (Tasks 4.1–4.2) — confirm boundary holds end-to-end.
