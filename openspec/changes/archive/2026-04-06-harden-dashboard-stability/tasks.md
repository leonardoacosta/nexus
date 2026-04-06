# Implementation Tasks

<!-- beads:epic:nx-dipk -->

## Infra Batch

- [x] [1.1] [P-1] Add `StartLimitBurst=5` and `StartLimitIntervalSec=30` to `[Unit]` in `deploy/nexus-dashboard.service` [owner:devops-engineer] [beads:nx-3bfo]
- [x] [1.2] [P-1] Install updated service file: `cp deploy/nexus-dashboard.service ~/.config/systemd/user/ && systemctl --user daemon-reload` [owner:devops-engineer] [beads:nx-yl5k]

## App Batch

- [x] [2.1] [P-1] Create `apps/nextjs/instrumentation.ts` with `register()` importing `./sentry.server.config` when `NEXT_RUNTIME === 'nodejs'` and exporting `onRequestError = Sentry.captureRequestError` [owner:ui-engineer] [beads:nx-ms8q]
- [x] [2.2] [P-2] Verify `pnpm typecheck` passes in `apps/nextjs/` with no TS-1128 diagnostic on `instrumentation.ts` [owner:ui-engineer] [beads:nx-q9us]
- [x] [2.3] [P-2] Rebuild dashboard: `cd apps/nextjs && pnpm build` [owner:devops-engineer] [beads:nx-u4kj]
- [x] [2.4] [P-3] Restart service: `systemctl --user restart nexus-dashboard` and confirm `systemctl --user status` shows `active (running)` [owner:devops-engineer] [beads:nx-7n4p]
