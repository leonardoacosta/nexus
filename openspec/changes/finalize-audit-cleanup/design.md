# Design: Finalize Audit Cleanup

## Why This Needs a Design Doc

This spec touches four unrelated-looking subsystems (audit tooling, process spawning, dashboard data fetching, DB schema) that share one root cause: **the previous audit cleanup pass treated symptoms, not structure.** Without a design doc we'd end up with four disconnected mini-specs that each work in isolation but leave the same friction in place.

The spec also introduces two genuinely new patterns (`safeSpawn`, `.audit-suppressions.json`) that future code will need to follow, and one structural inversion (dashboard reads become Drizzle-only) that changes how every Next.js feature will source data going forward.

## Architectural Principle

**The product is tmux harness management. Every design choice here should make that job easier, not harder.**

Corollary: tools (audit-scan, lint, type checkers) that flag the product's core capability as a smell need to be taught, not appeased. Code that wraps the product's core capability (spawning, PTY streaming) deserves first-class infrastructure, not ad-hoc hardening.

**Data topology clarification.** Nexus is compute-P2P over Tailscale but **data-centralized in a single shared Postgres**. Every `nexus-agent` instance reads and writes to the same `POSTGRES_URL`. The `agent_id` column is how entities are scoped to their writer — adding it to tables that lack one is not "making the schema multi-tenant," it is fixing an existing implicit assumption that only one agent exists. The dashboard dual-path collapse (Decision 4) works because every agent's data is already in the same DB.

## Key Decisions

### Decision 1: Suppression config, not inline annotations

**Options considered:**
- **A.** Inline `// audit: safe [D4 - reviewed]` comments on every intentional site
- **B.** Central `.audit-suppressions.json` keyed by (glob × check_id)
- **C.** Teach audit-scan to auto-detect "is a test file" and auto-skip test-only checks

**Chosen: B (central config) + partial C (auto-detect test files).**

Why: Inline comments spread the "what's intentional" knowledge across 110+ files, which is the same drift problem we're trying to solve elsewhere. A central config is one file to review in CI, one file to update when a check changes, and gives us a place to put the `reason:` field that makes intent explicit. Test-file auto-detection is safe for E7/E5/A6 (patterns that are universally fine in tests) and skips the config overhead for the highest-volume case.

**Config shape:**
```json
{
  "suppressions": [
    {
      "id": "D4",
      "paths": ["apps/agent/src/terminal/pty-source.ts", "apps/agent/src/services/pty*"],
      "reason": "tmux harness management is the product — spawn is core capability, wrapped by safeSpawn"
    },
    {
      "id": "D4",
      "paths": ["apps/agent/src/watcher-bridge.ts"],
      "reason": "Claude Code hook relay — spawns CC binary with validated project paths, migrated to safeSpawn"
    }
  ],
  "autoSkipTestFiles": ["E7", "E5", "A6"]
}
```

### Decision 2: safeSpawn returns a handle, not a Promise

```typescript
// packages/core/src/safe-spawn.ts
type SafeSpawnHandle = {
  pid: number;
  stdout: ReadableStream;
  stderr: ReadableStream;
  stdin: WritableStream;
  exitCode: Promise<number>;
  abort: (signal?: AbortSignal) => Promise<void>;
};

export function safeSpawn(
  binary: AllowedBinary,
  args: string[],
  opts?: { cwd?: string; env?: Record<string, string>; signal?: AbortSignal }
): SafeSpawnHandle
```

Why a handle and not `Promise<result>`: PTY streams are long-lived. `pty-source.ts` needs to read stdout incrementally while the process runs. A Promise-returning API would force every caller to fork into "run to completion" and "stream" code paths. The handle model is also how Bun's native `Bun.spawn` works, so we're aligning with runtime ergonomics.

**Allowlist:**
```typescript
const ALLOWED_BINARIES = [
  'tmux',     // product core
  'git',      // project discovery
  'claude',   // CC hook relay
  'ssh',      // terminal attach
  'bash',     // PTY shell
  'cat',      // session log tailing
  'nexus'     // self-invocation for CLI tests
] as const;
```

Any binary outside this list throws at call time with a clear error pointing to the allowlist constant. Adding a new binary is a one-line code change + PR — intentionally high friction.

### Decision 3: Arg validation by default, opt-out per call

```typescript
safeSpawn('tmux', ['new-session', '-d', '-s', sessionName])          // validated
safeSpawn('bash', ['-c', userScript], { trustArgs: true })            // opt-out
```

Validation rejects any arg that contains `; & | $ \` \n \r` unless `trustArgs: true` is passed. The opt-out is loud and reviewable (grep for `trustArgs` to find all un-validated calls). This is strictly safer than the current world where every `spawn()` call has its own ad-hoc (or missing) validation.

### Decision 4: Dashboard collapse — Drizzle for persisted, HTTP for live

**Taxonomy:**

| Entity | Persisted? | Read path after collapse |
|--------|-----------|--------------------------|
| `projects` (registered) | Yes | `@nexus/db` |
| `projects` (discovered on disk) | No (transient scan) | Agent HTTP (`GET /projects/discovered`) |
| `agents` (registry) | Yes | `@nexus/db` |
| `sessions` (historical list) | Yes | `@nexus/db` |
| `sessions` (attach stream) | No (live PTY) | Agent WebSocket |
| `health` (snapshots) | Yes | `@nexus/db` |
| `health` (current CPU/RAM) | No (sysinfo call) | Agent HTTP (`GET /health/current`) |
| `credentials` | Yes (encrypted) | `@nexus/db` via agent (never direct — secret boundary) |

Credentials stay behind the agent HTTP boundary because the encryption/decryption lives in the agent process. Everything else that's persisted moves to Drizzle. This is the taxonomy `AgentClient` will enforce after the collapse.

### Decision 5: Barrel exports from @nexus/db

Today `packages/db` has no `index.ts`. Next.js reaches into `src/schema/*` and `src/queries/*` directly, which is both a lint error (B2) and a symptom of the missing API surface.

**New shape:**
```
packages/db/
├── src/
│   ├── schema/        # internal — do not import directly
│   ├── queries/       # internal — do not import directly
│   └── index.ts       # PUBLIC API
└── package.json       # "exports": { ".": "./src/index.ts" }
```

`src/index.ts` re-exports:
- Inferred types: `Session`, `Project`, `Agent`, `HealthSnapshot`, `Credential` (`typeof table.$inferSelect`)
- Query functions: `getSessionsByAgent`, `getProjectById`, `listAgents`, etc.
- The raw `db` client (for transactions)

This doubles as the fix for Decision 4 — Next.js now has a clean import surface that doesn't require internal reaches.

### Decision 6: Relations() + agent_id columns on agent-scoped tables

Today `packages/db/src/schema/*` has no `relations()` definitions, AND three tables that should be agent-scoped (`health_snapshots`, `credentials`, `notifications`) have no `agent_id` column at all. That's two problems that must be solved together — you can't add a `relations(healthSnapshots, ({ one }) => ({ agent: one(agents, ...) }))` block if there's no FK column to reference.

**Live DB snapshot (2026-04-10):**

| Table | Rows | Has agent FK column? |
|---|---|---|
| `agents` | 1 (`omarchy`) | N/A (is the target) |
| `projects` | 34 | N/A (no agent scope today) |
| `sessions` | 0 | `machine text` (de-facto FK, no constraint) |
| `health_snapshots` | 2818 | **NO — add agent_id** |
| `credentials` | 0 | **NO — add agent_id** |
| `notifications` | 0 | **NO — add agent_id** |
| `project_locations` | ? | `agentId text` (de-facto FK, no constraint) |

**Schema evolution required before relations() can be added:**

1. `health_snapshots`: `ADD COLUMN agent_id text`, backfill all 2818 rows with `'omarchy'` (the only known agent), `SET NOT NULL`, add FK with `ON DELETE CASCADE` (historical metrics for a deleted agent have no meaning).
2. `credentials`: `ADD COLUMN agent_id text` (nullable). Nullable because `agent_id = NULL` means "shared pool across all agents" — which is the implicit semantic today. `ON DELETE SET NULL` — preserves the shared state when an agent is removed.
3. `notifications`: `ADD COLUMN agent_id text` (nullable). Same reasoning as credentials — notifications can be agent-scoped or global.

**After the columns exist,** add relations for: `sessions ↔ projects` (via `project_id`, new column), `sessions ↔ agents` (via `machine`, existing de-facto FK), `health_snapshots ↔ agents` (new), `credentials ↔ agents` (new), `projects ↔ agents` (many-to-many via `project_locations`), `notifications ↔ agents` (new, nullable).

### Decision 7: Fix the sessions.project schema drift

`sessions` has two columns pointing at the same concept:
- `project text NOT NULL` — original column, zero rows use it (sessions table is empty)
- `project_id text` (nullable) — dead drift from a prior attempt

And `projects.id` is a real `uuid` with 34 populated rows. The FK task in the original spec (`[1.9]`) asked for a FK between `sessions.project` (text) and `projects.id` (uuid) — which Postgres would reject on type mismatch.

**Chosen approach:**

1. **Drop `sessions.project text NOT NULL`** — unused (0 rows), architectural drift.
2. **Drop `sessions.project_id text`** — unused (0 rows), dead attempt.
3. **Re-add `sessions.project_id uuid REFERENCES projects(id) ON DELETE SET NULL`** — matches `projects.id` type, carries the FK natively, preserves historical sessions on project delete.

`SET NULL` preserves the dashboard's timeline view when projects are deleted. `CASCADE` would erase history. `RESTRICT` would frustrate cleanup.

**Blast radius: zero.** Sessions is empty. No backfill. No orphan cleanup. Clean cutover in a single migration.

**Migration file:** single Drizzle-generated SQL with `ALTER TABLE sessions DROP COLUMN project, DROP COLUMN project_id, ADD COLUMN project_id uuid REFERENCES projects(id) ON DELETE SET NULL`.

## Migration Strategy

Ordered to minimize blast radius at each step:

1. **Schema evolution first (column adds + drops).** Add `agent_id` to `health_snapshots`, `credentials`, `notifications`. Drop + re-add `sessions.project_id` as uuid. These are the prerequisites for relations() and for the dashboard dual-path collapse to work.
2. **Relations() after columns exist.** One per agent-scoped table, plus sessions/projects.
3. **Suppression config.** Deploy `.audit-suppressions.json` to drop the audit-scan noise floor before the pattern sweeps.
4. **safeSpawn wrapper.** Ship the wrapper in `@nexus/core` with tests before migrating any call sites.
5. **DB barrel exports.** Add `packages/db/src/index.ts` with re-exports. Existing internal imports keep working — the barrel is purely additive.
6. **Dashboard dual-path collapse.** Migrate Next.js reads to the barrel one file at a time. Delete `AgentClient.fetchAll*` only after all consumers are migrated.
7. **Pattern sweeps.** A9/C5/E7-production/E5-production cleanups. Mechanical, parallelizable.
8. **Bulk-close audit beads.** Only after the related tasks above are verified passing.

## Non-Goals (Deferred)

- **WebSocket PTY rate limiting (nx-dtk5).** Different domain (attack surface), needs its own threat model doc. Out of scope.
- **server.ts >500 lines (B4).** Already partially addressed by previous spec. Whatever's left is lower priority than the structural work here.
- **Soft-delete columns (C11).** We're a single-dev dev tool — hard delete is fine. Suppress this check rather than implement.
- **PostHog (F5) and /api/health (F8).** Add when we actually have external users to care about these signals.

## Open Questions

- Should `.audit-suppressions.json` live at repo root or inside `scripts/config/`? Root is more discoverable but adds a dotfile. Leaning root.
- Does `safeSpawn` need a synchronous variant for boot-time paths? Probably not — async fits everything we've got. Keeping the API single-mode until proven otherwise.

## Validation Plan

- Unit tests for `safeSpawn`: allowlist enforcement, arg validation, `trustArgs` escape hatch, signal cancellation
- Integration test for `.audit-suppressions.json`: run audit-scan before/after, assert specific check IDs drop
- Next.js E2E: dashboard pages still render with agent stopped (proves they're hitting Drizzle, not HTTP)
- Migration test: FK on `sessions.project` applied cleanly against snapshot of production data
- Audit verification: `audit-scan --json` composite >= 90 after all tasks complete
