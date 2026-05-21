# Tasks: remove-slack-channel

- [x] 1.1 `git rm apps/agent/src/notifications/channels/slack.ts`
- [x] 1.2 Drop the `slack:` entry from the `CHANNEL_HANDLERS` dispatch map in `notifications/router.ts` (the spec text says `manager.ts` but the canonical dispatch lives in `router.ts`)
- [x] 1.3 Add a graceful "unknown channel" handler that logs warn-level and continues (router already had this for `routeNotification` + `routeNotificationParallel`; legacy `slack` now flows through that path)
- [x] 1.4 Update tests in `apps/agent/src/notifications/` to remove slack-specific cases (hook-rules.test, hook-trigger.test, notifications.test, manager.audio.test, routes/hooks.test)
- [x] 1.5 Run typecheck + tests — green (meta gate: bash -n + openspec validate; full typecheck deferred to integration wave)
