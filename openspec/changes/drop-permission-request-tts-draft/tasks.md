<!-- beads:epic:nx-u2m9a -->
<!-- beads:feature:nx-bidsj -->

# Tasks — drop-permission-request-tts-draft

## API Batch

- [ ] 1.1 Modify `permissionRequestRule` in `apps/agent/src/notifications/hook-rules.ts` to return a single `desktop` draft — remove the `tts` draft entry and the nx-20caf transport-only comment block that justified it; keep `sessionName`/`sessionId` threading on the desktop draft [beads:nx-okdvj]
  - touches: `apps/agent/src/notifications/hook-rules.ts`
- [ ] 1.2 Update `apps/agent/src/notifications/hook-rules.test.ts` — assert `permissionRequestRule` returns exactly ONE draft with `channel === "desktop"`, correct title/body (`permission requested: <tool>` / `permission requested for <tool>`), and that no `tts`-channel draft exists [beads:nx-94gtd]
  - touches: `apps/agent/src/notifications/hook-rules.test.ts`
- [ ] 1.3 Update `apps/agent/src/notifications/manager-session-name.test.ts` fixtures (lines ~79-112 reference the permission notification shape) to the single-draft shape [beads:nx-wuit5]
  - touches: `apps/agent/src/notifications/manager-session-name.test.ts`
- [ ] 1.4 Run the agent notification test suite and paste passing output (`bun test apps/agent/src/notifications/` with `NEXUS_ATTACH_SECRET=test`) — gate for this batch [beads:nx-nz66o]

## E2E Batch

- [ ] 2.1 Runtime verification after deploy: pipe one fake `PermissionRequest` payload into `~/.claude/scripts/hooks/telemetry.sh` (no arg, `tool_name` set) and confirm via `journalctl --user -u nexus-agent` + the `notifications` table that exactly ONE notification row (channel `desktop`) and ONE alert push are produced for the event [beads:nx-dvz13]
