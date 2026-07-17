---
order: 0716b
---

# Drop the tts draft from permissionRequestRule (single push per permission event)

## Context

- depends on: none
- touches: `apps/agent/src/notifications/hook-rules.ts`, `apps/agent/src/notifications/hook-rules.test.ts`, `apps/agent/src/notifications/manager-session-name.test.ts`, `openspec/specs/hooks-endpoint/spec.md`

Found via `/explore` (2026-07-16), investigating "still getting 'permission requested' for every
question, and not notified for actual permission requests." Runtime evidence (`journalctl
--user -u nexus-agent` + `notifications` table): one `permission_request` socket event at
2026-07-17T00:45:23Z produced TWO notification rows 1ms apart — `fd6d30cd` (channel `desktop`)
and `7c9ef315` (channel `tts`) — and health-push alert-pushed BOTH to 3/3 devices, so every
permission event lands twice on the phone as a bare "permission requested for <tool>" banner.

Root cause: `permissionRequestRule` (`apps/agent/src/notifications/hook-rules.ts:236-238`) is
the only rule in the registry returning two drafts (`desktop` + `tts`); the manager writes one
row per channel and the push layer alerts every row. The tts draft's own comment (nx-20caf)
records that the primary spoken path lives in cc's `telemetry.sh` `nx_notify` — the agent-side
tts draft is transport plumbing, not the speech source, so pushing it as a second iOS alert is
pure duplication.

The upstream cc-side noise (three emitters per AskUserQuestion, tool name always empty) was
fixed the same session in the cc repo (commit `78d21bf7`: PreToolUse(AskUserQuestion) is now
bell-only via a `permission_bell` arm, the native PermissionRequest hook is the sole emitter,
and the socket event now carries `tool_name`); bead `nx-09shh.1` is closed. This proposal is
the remaining nx-side half.

Fix shape decided with Leo (2026-07-16 AskUserQuestion): drop the tts draft — the rule becomes
desktop-only, matching every other rule in the registry. Alternatives rejected: a push-layer
channel skip (touches the push path for all event types to fix one rule) and a per-draft
`pushEligible` flag (new schema field for a single consumer).

## What Changes

- `permissionRequestRule` in `apps/agent/src/notifications/hook-rules.ts` returns a single
  `desktop` draft. The tts draft (and its nx-20caf transport-only comment block) is removed;
  the `sessionName`/`sessionId` threading stays on the desktop draft (iOS deep-link still
  works — it rides the desktop row).
- `openspec/specs/hooks-endpoint/spec.md` `### Requirement: Selected hook events trigger
  notifications`: the rule-table row for `permission_request` changes from `desktop, tts` to
  `desktop`; the `permission_request fires desktop + tts` scenario is replaced with a
  desktop-only scenario plus an explicit no-tts-draft assertion.
- Tests asserting the two-draft shape are updated: `hook-rules.test.ts` (rule returns exactly
  one draft, channel `desktop`) and `manager-session-name.test.ts` (fixture rows at lines
  79-112 reference the permission notification shape).

## Non-Goals

- No change to the 2-second per-session suppression window
  (`dedupe-permission-request-notifications`, shipped 2026-07-15 — verified working).
- No change to the `notification` (nx_notify) ingest path — the rich
  "Leo, <project> needs permission for <tool>: ..." tts body from cc telemetry.sh continues to
  push and speak exactly as today; it is the intended single rich surface.
- No push-layer or NotificationDraft schema changes.

## Testing

- Unit (`apps/agent/src/notifications/hook-rules.test.ts`): `permissionRequestRule` returns
  exactly ONE draft with `channel === "desktop"`, title `permission requested: <tool>`, and
  threaded `sessionName`/`sessionId`; no draft with `channel === "tts"` exists in the result.
- Unit (`apps/agent/src/notifications/manager-session-name.test.ts`): existing fixtures updated
  to the single-draft shape; suite stays green.
- No e2e/UI surface — pure notification-rule shape change; `bun test` over `apps/agent`
  is the gate.
