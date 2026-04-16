# Proposal: Finalize Audit Cleanup

## Change ID
`finalize-audit-cleanup`

## Summary
Close out the 162 remaining findings from the 2026-04-10 audit by (1) teaching audit-scan to suppress intentional tmux/test patterns, (2) collapsing the dashboard's dual data paths, (3) centralizing all `exec/spawn` calls through a `safeSpawn` wrapper, and (4) finishing the pattern sweeps the previous `fix-audit-findings` spec left incomplete. Nexus's core job is managing tmux harnesses — the audit's signal needs to reflect that.

## Context
- Extends: `scripts/bin/audit-scan`, `packages/core/src/safe-spawn.ts` (new), `apps/nextjs/src/lib/agent-client.ts`, `apps/nextjs/src/lib/db.ts`, `apps/agent/src/terminal/pty-source.ts`, `apps/agent/src/watcher-bridge.ts`, `apps/agent/src/utils/exec.ts`, `apps/agent/src/routes/projects-discovered.ts`, `packages/db/src/schema/sessions.ts`, `packages/db/src/index.ts`
- Related archives: `2026-04-10-fix-audit-findings` (prior cleanup pass — deleted 9.2k LOC, added `fetchWithTimeout`, refactored server.ts, but left suppressions + dual-path + safeSpawn open)
- Related beads: `nx-acu2` (streamManager.shutdown leak on SIGTERM — overlaps A9), `nx-tev9` (no FK on sessions.project — overlaps C10/C11), `nx-8v2a` (no tilde expansion on projectsDir)
- Architecture review: `docs/diagrams/audit-tradeoffs-2026-04-09.html` identified dual-path as #1 instability source

## Motivation
The current audit scores 79/100 (B), up from 72/C but stuck. Three problems explain the stall:

1. **The signal is lying.** 110 of 144 errors (77%) come from patterns that are correct in context — `fetch()` without AbortController in test files (where tests *should* not time out on their own), sync `fs` at CLI/boot paths (where sync is idiomatic), and `spawn()` calls in `pty-source.ts` where spawning processes IS the product. Without suppression rules, every scan re-flags the same intentional code.
2. **The dashboard has two paths to the same data.** Next.js reads Postgres directly via `@nexus/db` AND calls each agent over HTTP for overlapping entities. Domain `Session` has already drifted from the DB row. This is the #1 structural instability identified by the architecture review.
3. **D4 spawn calls have no consistent hardening.** Today the 5 production spawn sites use raw `child_process.spawn` with varying arg handling. For a tmux-management tool, spawning IS the feature — the risk is arg injection, not existence.

Solving all three in one spec lets us drive the audit score above 90 without churn and removes the "what do we do about these findings?" friction that's blocking progress on real feature work.

## Requirements

### Requirement: audit-scan suppression model
audit-scan SHALL support a `.audit-suppressions.json` config at repo root that declares allowed patterns per check ID, per path glob. Test files SHALL be exempt from E7, E5, D4, and A6. Files under `apps/agent/src/terminal/` and `apps/agent/src/services/pty*` SHALL be exempt from D4 when the call goes through the `safeSpawn` wrapper.

### Requirement: safeSpawn wrapper
`@nexus/core` SHALL export a `safeSpawn(binary, args, opts)` utility that (a) validates the binary against an allowlist (`tmux`, `git`, `claude`, `ssh`, `bash`, `cat`, `nexus`), (b) requires args as a string array (never a string), (c) rejects any arg containing shell metacharacters unless explicitly allowlisted, (d) wraps the spawned process in an `AbortController`-compatible handle. All production `exec/spawn` calls SHALL migrate to `safeSpawn`.

### Requirement: Single read path for persisted entities
Next.js SHALL read persisted entities (projects, agent registry, health snapshots, session lists) exclusively through `@nexus/db` via public barrel exports. `AgentClient.fetchAllSessions`, `fetchAllHealth`, and `fetchAllProjects` SHALL be deleted. The agent HTTP API SHALL remain the path for live/ephemeral data only (attach, exec, SSE, discovered projects on disk).

### Requirement: Public barrel exports from @nexus/db
`@nexus/db` SHALL expose a public API surface that Next.js can consume without reaching into `/src/schema/*` or `/src/queries/*` internals. All 8 current B2 (internal-import) violations SHALL be resolved by switching callers to the public exports.

### Requirement: Unhandled rejection cleanup
All 6 A9 findings (`.then()` without `.catch()`) SHALL be fixed by wrapping each call with a `.catch()` that either reports to Sentry or explicitly ignores with a documented reason. The `streamManager.shutdown()` leak on SIGTERM (nx-acu2) SHALL be fixed as part of this cleanup.

### Requirement: SQL placeholder migration
The 2 C5 findings in `apps/agent/src/credentials/pool.ts:119` SHALL migrate from SQL template literal interpolation to `sql.placeholder()` or Drizzle's typed query builder.

### Requirement: Production fetch/sync-I/O sweeps
The ~5 production-path E7 sites (`apps/agent/src/routes/credentials.ts:302`, `notifications/channels/tts.ts:20`, `notifications/channels/slack.ts:19`, `server.ts:730`, `packages/core/src/fetch.ts:15`) SHALL be migrated to `fetchWithTimeout`. The ~5 production-path E5 sites (`apps/agent/src/services/spec-watcher.ts`, `services/config-loader.ts`, `services/command-registry.ts`, `db/agent-registry.ts`) SHALL remain sync where they are called only at boot, and move to async where they are called in request/watcher hot paths.

### Requirement: DB integrity
`packages/db/src/schema/*` SHALL define `relations()` for all 8 tables (closes C10). `sessions.project` SHALL gain a foreign key to `projects.id` with `ON DELETE SET NULL` (closes nx-tev9). `projectsDir` SHALL tilde-expand `~` paths before persistence and discovery (closes nx-8v2a).

### Requirement: Logging hygiene
The 1 A4 + 1 F2 `console.error` sites SHALL migrate to `Sentry.captureException`. The 3 H1 env vars missing from `.env.example` (`CLAUDE_PROJECT_DIR`, plus 2 others) SHALL be added. The 3 A6 `as any` test-file assertions SHALL be replaced with proper test-only types.

### Requirement: Audit score verification
After this spec lands, `audit-scan` SHALL report composite >= 90 and all category scores >= 80. The architecture axis SHALL improve from 73 to >= 85.

## Scope

- **IN**: audit-scan suppression config, safeSpawn wrapper + migration, dashboard dual-path collapse, @nexus/db barrel exports, A9/C5/A4/F2/H1/A6 cleanups, production E7/E5 sweeps, DB relations + FK, tilde expansion, bulk-close of obsolete audit beads
- **OUT**: Rust-crate dead code removal (done), server.ts route-table refactor (done), AppContext removal (done), nexus-status Rust→Bun rewrite (done), WebSocket PTY rate limiting (nx-dtk5, own spec), notification timeout (nx-t7ss, own spec), B4 >500-line file splits (deferred), info-level findings without beads (F5 PostHog, F8 /api/health, G10 env naming, A12 commented code, A5 TODO)

## Impact

| Area | Change |
|------|--------|
| `scripts/bin/audit-scan` | Add `.audit-suppressions.json` reader; skip matched (path × check_id) pairs |
| `packages/core` | New `safe-spawn.ts` module with allowlist + arg validation |
| `packages/db` | New `index.ts` barrel exports; add `relations()` to all schemas; add FK on `sessions.project` |
| `apps/agent/src/terminal/pty-source.ts` | Migrate to `safeSpawn` |
| `apps/agent/src/watcher-bridge.ts` | Migrate to `safeSpawn`; add `.catch()` on 2 A9 sites |
| `apps/agent/src/utils/exec.ts` | Replace with `safeSpawn` re-export |
| `apps/agent/src/routes/projects-discovered.ts` | Migrate to `safeSpawn` |
| `apps/agent/src/session-manager.ts` | Add `.catch()` on 2 A9 sites |
| `apps/agent/src/credentials/pool.ts` | Migrate SQL to `sql.placeholder()` |
| `apps/agent/src/routes/credentials.ts`, `server.ts`, `notifications/*` | Migrate to `fetchWithTimeout` |
| `apps/nextjs/src/lib/agent-client.ts` | Delete `fetchAllSessions/Health/Projects` |
| `apps/nextjs/src/lib/db.ts`, `lib/projects.ts`, `lib/get-client.ts` | Import from `@nexus/db` public API |
| `apps/nextjs/src/app/actions/{projects,settings}.ts`, `app/api/projects/route.ts` | Import from `@nexus/db` public API |
| `apps/agent/src/services/project-registry.ts` | Tilde-expand `projectsDir` |
| `apps/nextjs/src/components/CommandPalette.tsx`, `LazyTerminalPanel.tsx` | Add `.catch()` on A9 sites |
| `.env.example` | Add `CLAUDE_PROJECT_DIR` + 2 other missing vars |
| `.audit-suppressions.json` | New config file at repo root |

## Risks

| Risk | Mitigation |
|------|-----------|
| `safeSpawn` allowlist too strict, blocks a legit binary | Ship with broad allowlist; tighten after observation; log rejections with explicit error |
| Dual-path collapse breaks "live from machine" UX | Already tolerated via 1s cache in `agent-client.ts`; Next.js reads become stale by <= 5s, acceptable for a dev tool |
| Suppression config becomes a dumping ground for real bugs | Require every suppression entry to include a `reason:` field; lint config in CI |
| Bulk-closing audit beads hides unfixed items | Each closed bead MUST be cross-referenced to a completed task in this spec's `tasks.md` |
| Dropping `AgentClient.fetchAll*` breaks Next.js pages that depended on cross-machine data | Audit call sites first; if any page genuinely needs cross-machine aggregation, keep a read-only aggregation endpoint |
| DB FK on `sessions.project` fails migration if orphan rows exist | Migration script sets orphan `project` to NULL before adding FK |
