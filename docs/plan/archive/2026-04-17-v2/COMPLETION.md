# Plan Completion: v2

## Phase: v2 (post-MVP strategic scope)

## Completed: 2026-04-17

## Duration: artifacts locked across multiple weeks; formal close at 2026-04-17

## Honest Summary

**v2's roadmap was strategic scope, not an execution log.** Reconciliation at phase-close showed:

| Metric | Count |
|---|---|
| Specs listed in v2 `roadmap.md` | 43 |
| Specs in `openspec/changes/archive/` (lifetime) | 46 |
| Specs in both (delivered-as-planned by name) | **0** |

The 43 planned names (e.g., `add-agent-client`, `add-credential-pool`, `add-session-detection`, `add-command-palette`, `add-notification-system`, `add-dashboard-layout`) describe the core nexus system — and those systems **exist in the codebase today**, but they were built via different spec names, ad-hoc commits, or pre-v2 work that was already complete when the v2 roadmap was drafted.

Meanwhile the actual work stream during v2 was **responsive**: audit findings, bug reports, security/reliability issues, and user requests drove spec creation (e.g., `finalize-audit-cleanup`, `fix-audit-scan-rules`, `extend-audit-suppressions`, `fix-audit-real-debt`, `fix-audit-scan-rules-pass2`, `cleanup-residual-debt`, `split-b4-large-files`, `add-credential-swap-endpoint-ts`, `add-credential-lifecycle-tracking`, etc.).

This is a **structural observation about how the project operates**, not a failure to execute. v3 and beyond should account for this:

- **Option 1**: adopt a lighter plan artifact that's explicitly retrospective (record what shipped each period, not predict what will)
- **Option 2**: commit to roadmap names as spec names (requires stricter discipline during spec creation)
- **Option 3**: keep the strategic-scope purpose of the roadmap but drop the "will be executed verbatim" expectation (what v2 functionally was)

## Delivered (Planned systems — built via other names/paths)

The v2 roadmap described these systems; all operational in the codebase:

- Agent HTTP + WS server (`apps/agent/src/server.ts`, `server-websocket.ts`)
- Credential pool + rotation (`apps/agent/src/credentials/pool/`)
- Session detection + lifecycle (`apps/agent/src/session-manager.ts`, `watcher-bridge.ts`)
- Dashboard layout + components (`apps/nextjs/src/app/`, `components/`)
- Command palette (`apps/nextjs/src/components/CommandPalette.tsx`)
- Notification system (`apps/agent/src/notifications/`)
- Health monitoring (`apps/agent/src/health-*.ts`, `/health` page)
- Terminal attach (WebSocket PTY via `server-websocket.ts` + `stream-manager.ts`)
- Projects page + registry (`apps/nextjs/src/app/projects/`, `apps/agent/src/services/project-registry.ts`)
- Settings page (`apps/nextjs/src/app/settings/`)
- Xterm widget + lazy-loaded terminal (`apps/nextjs/src/components/LazyTerminalPanel.tsx`)

## Delivered (Unplanned — responsive to the actual work stream)

Specs archived during the v2 window that weren't in the roadmap:

- `finalize-audit-cleanup` — DB relations + FKs, safeSpawn wrapper, dual-path collapse
- `fix-audit-scan-rules` + `fix-audit-scan-rules-pass2` — B2/A9/E7 rule refinements
- `extend-audit-suppressions` — CLI-script + boot-path suppressions
- `fix-audit-real-debt` — Sentry migration, SQL placeholders, fetch timeouts, C-category DB
- `cleanup-residual-debt` — hostname→agentId, CORS 403, cursor pagination, A12 rule, 0600 cache
- `split-b4-large-files` — 6-file architectural splits behind barrels
- `add-credential-swap-endpoint-ts` — manual credential swap API
- `add-credential-lifecycle-tracking` — credential event tracking
- `migrate-nx-terraform` — Cloudflare DNS + homelab-postgres (in-flight, blocked on manual)
- `enforce-layering-dry-cleanup` — dashboard layering cleanup
- `add-type-codegen-bridge` — Rust↔TS type codegen
- `harden-sql-credential-pool` — SQL safety hardening
- `improve-credential-page-status` — credential page UX
- `cleanup-credential-table` — credential table cleanup

## Deferred / Carry-Forward to v3

### In-flight: migrate-nx-terraform (12/18 done, 6 `[user]`-blocked)

Remaining tasks all require Leo's keyboard:
- Create TF Cloud workspace `nx-prod` at app.terraform.io
- Fill `infra/.secrets.env` tokens (blocked on CX_POSTGRES_PASSWORD per memory)
- Run `pnpm tf init`
- Import existing Cloudflare DNS record
- Run `pnpm tf plan` + `pnpm tf apply`
- Push to main + verify hook pipeline

### Orphan-spec beads (ready queue pollution)

74 beads listed as "ready" in bd reference specs that aren't in `openspec/changes/`:
- `enforce-layering-dry-cleanup` — 13 tasks
- `add-type-codegen-bridge` — 9 tasks
- `migrate-nx-terraform` — 7 tasks (in-flight; the ones counted above)
- `improve-credential-page-status` — 2 tasks
- `harden-sql-credential-pool` — 2 tasks
- `add-credential-lifecycle-tracking` — 2 tasks
- `cleanup-credential-table` — 1 task
- Plus ~40 standalone tasks

These need verification-sweep (same pattern applied to terminal-attach, credential-mgmt, notification, session-management epics during 2026-04-17 session — closed 20+ stale beads). Likely outcome: most are already-delivered or stale; a handful are real future work.

### One real future-work bead

`nx-wce7` — Add credential_swaps table for per-session credential rotation history. Filed from `attribution.ts` TODO during cleanup-residual-debt. Genuine tracking, not stale.

## Metrics at v2 close

### Codebase
- TypeScript files: 347
- Test files: 107
- Rust crates: `nexus-core`, `nexus-agent`, `nexus-tui` (per CLAUDE.md; the Rust impl was superseded by Bun during v2 per memory)

### Audit posture
- Composite score: **100/A** (up from 72/C at v2 start based on fix-audit-cleanup archive history)
- Axes: quality 99, structure 100, architecture 100
- Total findings: 4 (all info-level: B3, C11, F5, F8, G10)
- Suppressions: 227 total (92 by-config + 135 auto-skip-test-files)

### Bead queue
- Total issues lifetime: 1055
- Open: 74 (mostly orphan-spec cruft per above)
- Closed: 981

### Spec archive
- 46 archived specs total (cumulative across all plan phases)
- 8 archived during 2026-04-17 session alone (score 72→100 trajectory)

## Lessons

### What worked

1. **Responsive spec creation beats top-down planning for a solo-dev tool**. The audit-cleanup spec chain (8 specs over 2 days, score 72→100) was entirely reactive — each spec surfaced findings that shaped the next. This produced better outcomes than executing the v2 roadmap verbatim would have.
2. **Stale-bead sweeps as a hygiene pattern**. When bead queue grew from tool-vs-reality drift, parallel verification sweeps closed 20+ stale beads cheaply. Adopt as periodic ritual, not just end-of-cycle cleanup.
3. **Honest `reason:` fields on deferrals**. `cleanup-residual-debt`'s pattern of "file a tracking bead AND suppress, with bead ID in the reason" made deferred work discoverable without masking it. Keep this.
4. **Rule refinements as first-class spec work**. `fix-audit-scan-rules-pass2`, `cleanup-residual-debt`'s A12 refinement — spending spec effort on making tools honest paid off more than fixing the same tool-reported "issues" would have.

### What didn't

1. **Roadmap-as-contract assumption**. v2's roadmap was drafted with an implicit expectation that named specs would be executed verbatim. Reality was different. For v3, either drop that expectation or invest in the discipline to enforce it.
2. **Bead queue as priority signal**. Multiple sessions' `/next` output ranked P1 work that was already done — the tool lies when tracking drift exceeds sweep cadence. Mitigation: periodic sweeps, better bead lifecycle management, or a different priority signal (e.g., open PRs, Sentry issues, user asks).
3. **Late-day architectural work**. The `split-b4-large-files` spec was the right work but executed at midnight against the explicit "this is a bad time" warning — ended cleanly this time, but luck. For v3, respect cognitive-budget signals.

### What surprised me

1. **How much "stale" isn't stale in the code**. The terminal-attach, credential-mgmt, notification, and session-management epic sweeps revealed that ~85% of "P1 unaddressed" beads were already-implemented. The Rust→Bun migration (per memory) was the largest single drift source. Migration periods need dedicated bead lifecycle passes.
2. **Audit tooling refinement compounds**. `fix-audit-scan-rules` (pass 1) + `fix-audit-scan-rules-pass2` together retired 6+ suppression entries that would have been maintained forever. Small tool fixes → cascading reductions in noise.

## Closing observation

v2 closes with the codebase at its cleanest state in the project's lifetime: score 100/A, 0 P0/P1 debt, suppression file is all-justified entries, integration tests encode baselines. v3 starts from a trustworthy foundation — a rare luxury.
