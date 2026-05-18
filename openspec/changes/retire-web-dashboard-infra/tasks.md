# Tasks: retire-web-dashboard-infra

- [x] 1.1 Confirm p5-parity-audit.md is 100% checked

  All 10 rows in `docs/plan/spine-migration/p5-parity-audit.md` show `done` status (sessions/specs/projects/credentials/failures/notifications/settings/health/integrations/pty viewer). Wave-5 deliverables under bd:nx-gaquu shipped. Parity-audit side of the gate unblocked.

- [x] [ops-agent] 1.2 [user] systemctl --user stop nexus-dashboard

  Executed via SSH to homelab 2026-05-18 (Op 1 of wave-5 ops). nx-6b60o closed. Service was active (running) since 2026-05-17 18:22:09 CDT, now inactive (dead).

- [x] [ops-agent] 1.3 [user] systemctl --user disable nexus-dashboard

  Executed via SSH to homelab 2026-05-18 (Op 1 of wave-5 ops). nx-6b60o closed. Service unit now disabled.

- [x] 1.4 Audit deploy/nexus-bundle-manager.sh — confirm it's web-only

  **FINDING: script is NOT web-only.** Audit revealed `deploy/nexus-bundle-manager.sh` builds per-project macOS .app bundles so terminal-notifier can pass `-sender <bundle-id>` and render project-emoji as the notification banner's left app icon (Catalina+ runtime icon overrides via UNUserNotificationCenter are silently ignored without a bundle ID).

  Active callers in repo:
  - `deploy/nexus-notifier.sh:377-382` — invokes `ensure` / `ensure-default` subcommands during notification dispatch
  - `deploy/nexus-listener.ts:246` — comment-only doc reference

  Script belongs to the macOS notification pipeline, not the web dashboard stack. Deletion would break notifier flow.

  **Action**: SKIPPED deletion of `deploy/nexus-bundle-manager.sh`. Follow-up tracked in **bd:nx-uw5kc** "Decide bundle-manager fate post-web-retirement". Spec's "if web-only" qualifier honored.

- [x] [partial] 1.5 git rm -r apps/nextjs/ packages/ui/ deploy/nexus-dashboard.service deploy/traefik/ (bundle-manager.sh skipped per 1.4)

  Removed:
  - `apps/nextjs/` (~154 files — Next.js 15 dashboard + acceptance test suite)
  - `packages/ui/` (~15 files — Badge, Card, Gauge, Sparkline, StatusDot + tests)
  - `deploy/nexus-dashboard.service` (systemd unit)
  - `deploy/traefik/nexus-dashboard.yml` + parent dir (Traefik dynamic routing config)
  - `deploy/hooks.d/post-merge/04-dashboard` (post-merge deploy hook for dashboard, moved here from task 1.7 since the whole script is dashboard-only)

  Not removed: `deploy/nexus-bundle-manager.sh` (notifier-pipeline dependency, see 1.4 finding).

- [x] 1.6 Remove apps/nextjs and packages/ui from tsconfig.json root references

  Dropped both lines from `tsconfig.json` references array. Remaining references: packages/core, packages/db, apps/agent, apps/nexus-statusline.

- [x] 1.7 Remove web-related deploy steps from deploy/hooks.d/

  Audited both hooks.d/ trees. Web references located in:
  - `deploy/hooks.d/post-merge/04-dashboard` — entire script is dashboard build+restart; deleted as part of task 1.5.
  - `deploy/hooks.d/pre-push/01-deploy` (lines 108-124) — embedded "Dashboard (Next.js) rebuild + restart if changed" block within the Linux branch. Removed; pre-push now only handles nexus-agent.

  Other hooks (`01-beads`, `02-deploy`, `03-migrate`, `05-nexus-emit`, `pre-push/02-nexus-emit`) had zero web references; left untouched.

- [x] 1.8 Single commit "chore: retire web dashboard stack"

  Wave-5 spec executes web-retirement as one commit alongside tasks.md update + .beads/ flush. Bundle-manager skip + nx-uw5kc note included in commit body so the audit decision is visible in git log.

- [x] 1.9 Verify no other code references @nexus/ui or @nexus/nextjs

  Post-deletion grep:
  ```
  grep -rn "@nexus/ui\|@nexus/nextjs" apps/ packages/ deploy/ 2>/dev/null
  ```
  → zero matches. Web package identifiers fully orphaned.
