<!-- beads:epic:nx-u2m9a -->
<!-- beads:feature:nx-bidsj -->

# Tasks — drop-permission-request-tts-draft

## API Batch

- [x] 1.1 Remove `permissionRequestRule` and its registry entry from `apps/agent/src/notifications/hook-rules.ts` (registry 5 → 4; update the registry-count file-header comment) and remove the now-dead `permission_request` suppression key branch in `apps/agent/src/notifications/hook-trigger.ts`; the `permission_request` event stays recognized/persisted, only the notification mapping goes [beads:nx-okdvj]
  - touches: `apps/agent/src/notifications/hook-rules.ts`, `apps/agent/src/notifications/hook-trigger.ts`
- [x] 1.2 Update `apps/agent/src/notifications/hook-rules.test.ts` — assert the registry has exactly FOUR entries with no `permission_request` key, and that a `permission_request` payload through `evaluateAndDispatch` produces zero drafts [beads:nx-94gtd]
  - touches: `apps/agent/src/notifications/hook-rules.test.ts`
- [x] 1.3 Update `apps/agent/src/notifications/manager-session-name.test.ts` fixtures (lines ~79-112 reference the permission notification shape) — replace permission-shaped fixtures with a non-permission event shape so the sessionName-threading coverage survives [beads:nx-wuit5]
  - touches: `apps/agent/src/notifications/manager-session-name.test.ts`
- [x] 1.4 Accept optional `session_name`/`session_id` on `POST /notifications/send` (`apps/agent/src/routes/notifications.ts`) and thread them to `manager.send()` extras as `sessionName`/`sessionId` (manager + APNs push layer already consume them; absent fields degrade to today's shape) [beads:nx-bidsj.1]
  - depends on: 1.1
  - touches: `apps/agent/src/routes/notifications.ts`
- [x] 1.5 Route tests for session-field threading — payload with `session_name`/`session_id` reaches `manager.send()` extras (and the composed push title `<project> · <session>`); payload without them produces today's exact shape [beads:nx-bidsj.2]
  - depends on: 1.4
  - touches: `apps/agent/src/routes/notifications.test.ts`
- [x] 1.5b `composeTitle` in `apps/agent/src/health-push/notification-push.ts` skips the project segment when the session name already starts with `<project> · ` or equals the project (CC session names are conventionally `<code> · <branch>`-shaped — blind composition yields `cc · cc · main`); unit-cover both the dedup and the unrelated-name compose case [beads:nx-bidsj.3]
  - touches: `apps/agent/src/health-push/notification-push.ts`, `apps/agent/src/health-push/notification-push.e2e.test.ts`
- [x] 1.6 Run the agent notification + routes test suites and paste passing output (`bun test apps/agent/src/notifications/ apps/agent/src/routes/notifications.test.ts` with `NEXUS_ATTACH_SECRET=test`) — gate for this batch [beads:nx-nz66o]

## E2E Batch

- [x] 2.1 Runtime verification after deploy: pipe one fake `PermissionRequest` payload (multi-question `tool_input.questions`) into `~/.claude/scripts/hooks/telemetry.sh` (no arg, `tool_name` set) and confirm via `journalctl --user -u nexus-agent` + the `notifications` table that exactly ONE notification row lands for the event (the rich body enumerating all questions), ONE alert push fires, and the push title is `<project> · <session>` with `sessionId` present in the push log line [beads:nx-dvz13]
  - verified live (2026-07-16, post-deploy of commit 0a579502): piped a fake
    AskUserQuestion `PermissionRequest` (2 questions) with a fake
    `transcript_path` carrying `customTitle: "apply-verify"` into
    `telemetry.sh`. journalctl showed exactly ONE `socket: permission_request`
    event, ONE `notifications:router` entry, and ONE alert push
    (`sent to 3/3 device(s) ... title="nx · apply-verify" sessionId=test-verify-1784259622`).
    `SELECT ... FROM notifications WHERE id = 'cc-1784259622-31877'` confirmed
    exactly one row (channel=tts, status=delivered).
