# Tasks: collapse-notifications-dir

- [ ] 1.1 Confirm P1.4 (remove-slack-channel) and P4.7 (remove-notification-channels) are merged
- [ ] 1.2 `git mv apps/agent/src/notifications/manager.ts apps/agent/src/notifications.ts`
- [ ] 1.3 Run `safe-rename '@/notifications/manager' '@/notifications'` across `apps/agent/src/`
- [ ] 1.4 Delete the now-empty `apps/agent/src/notifications/` directory
- [ ] 1.5 Run `pnpm --filter @nexus/agent typecheck` — zero errors
- [ ] 1.6 Run `pnpm --filter @nexus/agent test` — green
