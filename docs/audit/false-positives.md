# Audit False Positives — nexus

> Per-repo record of finding shapes that are NOT real defects on this codebase.
> Contract: `~/.claude/commands/improve/references/lens-shared.md` § False-Positive
> Suppression. Apply with verify-before-suppress semantics — a candidate finding may
> only be suppressed by matching an actual grep/Read against the cited pattern below,
> never by filename alone. Append new confirmed shapes; do not delete rows without a
> re-verification note.

| Shape | Cited pattern | Why not a defect | Recorded |
| --- | --- | --- | --- |
| Duplicate `tmux list-panes -a` implementations (arch/dup checks) | `apps/agent/src/services/socket-server/pane-translation.ts:5-16` header: "Sibling to process-watcher.ts's own private listTmuxPanes — NOT a duplicate" | Deliberate, documented design: different projections (pid-keyed PaneInfo join vs %N->canonical-address correlation). REFUTED by adversarial verify (improve:code, c25cd89d). | 2026-07-19 |
| Sync I/O in one-shot startup, tiny-file timers, virtual fs, short-lived CLIs (E5) | e.g. `apps/nexus-emit/src/index.ts:31,81` (CLI), `apps/agent/src/services/memory-pressure.ts` (procfs/cgroupfs), `statusline-*-poller` 3s/30s tiny-file reads, `state-snapshot.ts` atomic tmp+rename flush | Accepted Bun idiom: one-shot or bounded tiny reads off the request path. Only recurring-poller-on-growing-files or request/ingest-path sync I/O is a finding (see PERF-SYNC-01..03, improve:code 2026-07-19). | 2026-07-19 |
| `findMany()` without limit in `*.test.ts` (C15) | `apps/agent/src/services/reaper-job.e2e.test.ts`, `reaper-persistence.test.ts` | Test fixtures over bounded seeded datasets; scanner test-file auto-skip leak. | 2026-07-19 |
| Missing Sentry/PostHog//api/health in `apps/web` (F1/F5/F8) | `apps/web` — internal radar/terminal-attach surface | By-design: web dashboard role retired (`openspec/changes/archive/2026-05-21-retire-web-dashboard-infra`); fleet observability canon is Grafana LGTM, not product analytics. | 2026-07-19 |
| `RegExp.exec(...)` matched by exec/spawn regex (D4) | 10 of 15 surviving D4 hits at c25cd89d, e.g. `apps/agent/src/services/git-observer.ts:124`, `spec-watcher/fs-snapshot.ts:45` | Scanner regex matches `RegExp.prototype.exec`, not subprocess spawning. Verify by reading the cited line: a regex `.exec(` call is a non-finding. | 2026-07-19 |
| `DOTFILES` / `NEXUS_REPO_ROOT` missing from `.env.example` (H1) | By-design exemptions per the live env-catalog spec (verifier-CORRECTED, ENV-H1-1) | Explicit documented exemptions, not drift. | 2026-07-19 |
| `sql` template interpolation in drizzle sites (C5) | `packages/db/src/schema/projects.ts:44`, `apps/agent/src/db/database.ts:121`, `services/process-watcher.ts:907`, `routes/analytics.ts:553`, `scripts/backfill-hook-schema-fingerprints.ts:123` | Verified internal constants/identifiers (drizzle `sql` tag parameterizes values); no user/network input reaches the template. Re-verify any NEW site before suppressing. | 2026-07-19 |
