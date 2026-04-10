# Proposal: Simplify Agent — Quick Wins (execJson, Config Cache, Split God Route)

## Change ID
`simplify-agent-quick-wins`

## Summary
Three low-risk, high-leverage improvements to the Bun agent: a shared subprocess helper to eliminate boilerplate across 9 spawn sites, cached config reads to remove per-request disk I/O, and splitting the 683-line operational.ts into 6 focused route files.

## Context
- Extends: `apps/agent/src/routes/`, `apps/agent/src/services/`, `apps/agent/src/server.ts`
- Related: Architecture review (2026-04-09) findings 1-3

## Motivation
The Bun consolidation (Wave 1-5) ported capabilities fast. Three patterns emerged that add maintenance friction: (1) 9 `Bun.spawn` call sites each independently handling stdout buffering, timeout, and JSON parsing — no shared error handling. (2) `projects.json` and `settings.json` read with `readFileSync` on every HTTP request — blocking the event loop. (3) `operational.ts` at 683 lines contains 6 unrelated endpoints (statusline, hooks, recommend, environment, failures, cron) with zero test coverage. These are independent fixes that each take ~1 day.

## Requirements

### Req-1: Shared execJson helper
Create `apps/agent/src/utils/exec.ts` with a typed subprocess helper: `execJson<T>(cmd, args, opts?)` that handles stdout capture, timeout (default 10s), JSON parsing, and error wrapping. Replace all 9 `Bun.spawn` call sites in routes/ and services/ with this helper.

### Req-2: Cached config reads
Replace `readFileSync('projects.json')` (called per-request in project-detail.ts and operational.ts) with a singleton config loader that reads once at startup, watches for file changes via `fs.watch`, and serves from memory. Same for `settings.json` reads in operational.ts and cron.ts.

### Req-3: Split operational.ts
Split the 683-line file into 6 focused route files: `statusline.ts` (~120L), `hooks.ts` (~80L), `recommend.ts` (~150L), `environment.ts` (~90L), `failures.ts` (~60L), `cron-routes.ts` (~80L). Update server.ts imports. Each file becomes independently testable.

## Scope
- **IN**: execJson helper, config caching, operational.ts split, server.ts import updates
- **OUT**: Changing route behavior or API contracts, adding new routes, modifying event routing

## Impact
| Area | Change |
|------|--------|
| `apps/agent/src/utils/exec.ts` | New shared subprocess helper (~50 LOC) |
| `apps/agent/src/routes/specs.ts` | Replace Bun.spawn with execJson |
| `apps/agent/src/routes/project-detail.ts` | Replace Bun.spawn with execJson, use cached config |
| `apps/agent/src/routes/operational.ts` | Split into 6 files, deleted |
| `apps/agent/src/routes/sessions.ts` | Replace Bun.spawn with execJson |
| `apps/agent/src/services/cron.ts` | Replace Bun.spawn with execJson, use cached config |
| `apps/agent/src/services/spec-watcher.ts` | Replace Bun.spawn with execJson |
| `apps/agent/src/services/config-loader.ts` | New cached config service |
| `apps/agent/src/server.ts` | Updated imports for split routes |

## Risks
| Risk | Mitigation |
|------|-----------|
| execJson changes subprocess error handling semantics | Preserve existing behavior — throw on non-zero exit, return parsed JSON on success |
| Config watch misses rapid file edits | Use 500ms debounce on fs.watch callback |
| Route split breaks server.ts registration | Update imports atomically, verify all endpoints respond |
