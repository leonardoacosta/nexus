# Proposal: Extend Audit Suppressions

## Change ID
`extend-audit-suppressions`

## Summary
Add four suppression categories to `.audit-suppressions.json` to silence tool-noise findings that are intentionally-correct-in-context: CLI-script console output (A2/F2), boot-phase sync I/O (E5), and safeSpawn self-reference + constant-arg execs (D4). File a follow-up bead for the 3 genuinely-real UI console.error sites that the prior finalize-audit-cleanup spec missed.

## Context
- Extends: `/home/nyaptor/dev/nx/.audit-suppressions.json`
- Related capability: `audit-suppressions` (existing — config file + reader + CI lint already shipped)
- Related archives: `2026-04-16-fix-audit-scan-rules` (just shipped — fixed B2 + A9 rule bugs, score 71→77), `2026-04-16-finalize-audit-cleanup` (created the suppression infrastructure)
- Related beads: `nx-hqu4` (raise-audit-score follow-up, this spec is one of the three identified subtasks)
- Current audit baseline after `fix-audit-scan-rules`: composite 77/B, axes quality 76, structure 83, architecture 74

## Motivation

After Wave 1 (rule fixes), the remaining 127 findings cluster in three patterns, all of which are **correct code that the audit rules can't distinguish from real debt**:

1. **CLI scripts log to stdout/stderr** — `backfill-*.ts`, `import-credentials.ts`, `probe-credential-identity.ts`, and `packages/db/src/migrate.ts` use `console.log`/`console.error` because that IS their output channel. These are one-shot scripts, not production hot paths. 25 A2 + 14 F2 findings evaporate with one suppression entry.

2. **Boot-phase config loaders use sync I/O** — `packages/core/src/config.ts`, `apps/agent/src/services/config-loader.ts`, `spec-watcher.ts`, `command-registry.ts`, `agent-registry.ts`, and `apps/nexus-status/src/index.ts` all read config files synchronously at module load. The prior `finalize-audit-cleanup` spec's Scope explicitly stated these SHALL remain sync ("where they are called only at boot") — but the suppression config didn't get extended to match. 22 E5 findings evaporate.

3. **safeSpawn wrapper self-reference + nexus-status constant-arg execs** — `packages/core/src/safe-spawn.ts:196` uses `spawn` internally (it IS the wrapper). `apps/nexus-status/src/index.ts:147,154,163` runs `execSync('git ...')` with constant/literal args (no user input, no injection surface). `apps/agent/src/db/agent-registry.ts:11` runs `tailscale ip -4`. None are meaningful D4 risks. 5 D4 findings evaporate.

Separately, the 3 remaining UI F2 sites (`CommandPalette.tsx:136,139`, `LazyTerminalPanel.tsx:8`) ARE real — the `finalize-audit-cleanup` task 3.15 migrated line 136 to Sentry but missed 139 and LazyTerminalPanel entirely. Those become a P3 follow-up issue, NOT a suppression.

**Expected score impact:** composite 77 → 87-90 range. Each suppression removes a finding without touching product code. The score moves because the scoring model counts unsuppressed findings per category — removing 66 tool-noise findings shifts quality, performance, observability, and security category scores up proportionally.

## Requirements

### Requirement: Suppress CLI script console output

`.audit-suppressions.json` SHALL include entries that suppress A2 and F2 findings in CLI scripts (`apps/agent/src/scripts/**`) and one-shot runners (`packages/db/src/migrate.ts`). Each entry SHALL name the specific path glob and include a `reason` field explaining why console output is the intentional output channel for that path.

### Requirement: Suppress boot-phase sync I/O

`.audit-suppressions.json` SHALL include entries that suppress E5 findings in the following boot-phase paths: `packages/core/src/config.ts`, `apps/agent/src/services/config-loader.ts`, `apps/agent/src/services/spec-watcher.ts`, `apps/agent/src/services/command-registry.ts`, `apps/agent/src/db/agent-registry.ts`, and `apps/nexus-status/src/**`. The `reason` SHALL reference the prior spec's design decision that these paths are intentionally sync at boot.

### Requirement: Suppress safeSpawn self-reference and constant-arg execs

`.audit-suppressions.json` SHALL include a D4 entry for `packages/core/src/safe-spawn.ts` (wrapper self-reference) and for `apps/nexus-status/src/**` (constant-arg git probes) and for `apps/agent/src/db/agent-registry.ts` (tailscale ip lookup with no user input). Each entry SHALL explain why the spawn is trusted.

### Requirement: File follow-up for real UI console.error sites

A P3 beads issue SHALL be filed covering the 3 remaining F2 findings in Next.js UI components (`apps/nextjs/src/components/CommandPalette.tsx` lines 136 and 139, `apps/nextjs/src/components/LazyTerminalPanel.tsx` line 8). These are NOT to be suppressed — they are genuine debt from the prior `finalize-audit-cleanup` task 3.15 that only fixed CommandPalette:136 and missed the others.

### Requirement: Post-suppression verification

After the config is updated, running audit-scan against `/home/nyaptor/dev/nx` SHALL produce: zero A2 findings, zero E5 findings, zero D4 findings outside the allowlist, and F2 findings count equal to 3 (the unsuppressed UI debt). The suppression counter SHALL reflect the added entries (`by_config` count increases by the suppressed finding total). Composite score SHALL improve from 77 by at least 6 points (target: 83+, stretch: 87+).

## Scope

- **IN**: A2/F2/E5/D4 suppression entries in `.audit-suppressions.json`, one P3 follow-up bead for UI console.error debt, updated integration-test assertions (score threshold, A2/E5/D4 zero, F2 == 3)
- **OUT**: Fixing the UI console.error sites (that's the follow-up bead, separate spec), any code changes to scripts or boot loaders, B4 large-file splits, C-category DB debt, any new suppressions beyond the four categories listed

## Impact

| Area | Change |
|------|--------|
| `.audit-suppressions.json` | +4 new suppression entries (A2 scripts/migrate, F2 scripts/migrate, E5 boot loaders, D4 wrapper + nexus-status + tailscale) with `reason` fields |
| `packages/core/src/audit-suppressions.integration.test.ts` | Update baseline assertions: A2 count 0, E5 count 0, F2 count 3 (documented UI debt), D4 count 0 outside allowlist, composite score threshold raised from documented-71 baseline to >= 83 |
| `.beads/` | New P3 beads issue "Fix remaining F2 UI console.error sites — CommandPalette + LazyTerminalPanel should use Sentry" |
| `scripts/validate-audit-suppressions.sh` | No changes needed — existing lint already enforces `reason` field on each entry |

## Risks

| Risk | Mitigation |
|------|-----------|
| Suppression hides a real future bug (e.g., a new console.log slips into a production path that looks like a script) | Globs are path-scoped (`apps/agent/src/scripts/**`, not `apps/**`); any new path for scripts needs an explicit config entry, which surfaces during PR review |
| Integration test's new score threshold (>= 83) becomes a flaky gate if `audit-scan` rules change | Use `>=` comparison, not `==`; test already documents the specific expected counts per rule which are the real regression signal. Score is a coarse indicator |
| Boot-loader suppressions mask a later refactor that moves them out of boot paths | The suppression `reason` field documents the "boot-only" invariant; if a file graduates to request-path use, the suppression entry becomes obviously misleading and gets reviewed |
| UI debt follow-up bead gets buried and never fixed | File with P3 (Minor), label as `audit-debt`, link to this spec's archive so it surfaces on the next `bd ready` sweep of P3s |
