# Tasks: remove-slack-channel

- [ ] 1.1 `git rm apps/agent/src/notifications/channels/slack.ts`
- [ ] 1.2 Drop the `case 'slack':` branch from `notifications/manager.ts` channel dispatch
- [ ] 1.3 Add a graceful "unknown channel" handler that logs warn-level and continues
- [ ] 1.4 Update tests in `apps/agent/src/notifications/` to remove slack-specific cases
- [ ] 1.5 Run typecheck + tests — green
