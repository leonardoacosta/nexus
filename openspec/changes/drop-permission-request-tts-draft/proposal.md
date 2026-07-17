---
order: 0716b
---

# Single rich banner per permission event (drop the agent-side contentless drafts)

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

## Amendment (2026-07-16, second AskUserQuestion — Leo picked "Extend nx-bidsj spec")

Same-night runtime evidence (journalctl 02:09:02Z + `notifications` table) showed the original
scope was insufficient: one AskUserQuestion event currently lands as THREE phone pushes — the
agent rule's desktop + tts drafts (each minted with its own `randomUUID()` in `hook-trigger.ts`,
so the push layer's dedup-by-id never collapses them) PLUS cc telemetry.sh's rich `nx_notify`
row. Dropping only the tts draft still leaves TWO: a contentless "permission requested for
AskUserQuestion" banner beside the rich one carrying the actual question text. Leo's ask: ONE
banner, carrying the questions, titled with the project/session — so the agent-side
`permission_request` notification rule is removed ENTIRELY and the rich `nx_notify` surface
gains the session fields it lacks.

cc-side prerequisites already shipped (cc repo, same night): `9d38ce39` (project detection —
git-toplevel + projects.json code, kills the "personal" mislabel), `4866399f` (foregrounded the
permission-arm `nx_notify` — the backgrounded curl intermittently lost the hook process-reap
race; the 02:02:48Z event delivered its socket event but never its rich notification), and
`8dc7865b` (`nx_notify` wire now carries `session_name`/`session_id`; older agents ignore the
extra keys, so cc-first ordering is safe).

## What Changes

- `permissionRequestRule` is REMOVED from the rule registry in
  `apps/agent/src/notifications/hook-rules.ts` (registry drops 5 → 4 entries). The rich
  `nx_notify` POST from cc telemetry.sh — which enumerates every question and its answer
  choices in one body — becomes the sole notification surface for permission events. The
  `permission_request` socket event itself is still recognized and persisted (telemetry /
  session_events path untouched); only the notification mapping goes. The now-dead
  `permission_request` suppression key in `hook-trigger.ts` is removed with it.
- `POST /notifications/send` (`apps/agent/src/routes/notifications.ts`) accepts optional
  `session_name` / `session_id` body fields and threads them to `manager.send()` extras
  (`sessionName`/`sessionId` — already supported by the manager and the APNs push layer), so
  the banner titles `<project> · <session>` via `composeTitle` and deep-links to the session.
- `composeTitle` (`apps/agent/src/health-push/notification-push.ts`) gains a duplicate-prefix
  guard: when the session name already starts with `<project> · ` (or equals the project), the
  project segment is skipped — CC session names are conventionally `<code> · <branch>`-shaped,
  so blind composition would render `cc · cc · main`.
- `openspec/specs/hooks-endpoint/spec.md` `### Requirement: Selected hook events trigger
  notifications`: the `permission_request` row is removed from the trigger table; its scenario
  asserts NO notification is dispatched for the event (rich surface arrives via
  `/notifications/send`); a new scenario covers session-field threading on the send route.
- Tests updated: `hook-rules.test.ts` (registry has exactly four entries, no
  `permission_request` key), `manager-session-name.test.ts` (permission-shaped fixtures
  replaced), and the notifications route tests (session fields thread through; absent fields
  degrade to today's shape).

## Non-Goals

- No change to the remaining suppression windows for other event types.
- No change to the rich body's wording — telemetry.sh's question/choices enumeration is
  already correct (verified live 02:18:25Z: both questions of a two-question call bundled in
  one body, project resolved to `nx`, title `🔭 Nexus`).
- `apiErrorRule` still returns desktop + tts drafts with distinct ids and therefore still
  double-pushes on api errors — same defect class, deliberately out of scope here; tracked as
  a follow-up candidate, not silently absorbed.
- No push-layer or NotificationDraft schema changes.

## Testing

- Unit (`apps/agent/src/notifications/hook-rules.test.ts`): the rule registry has exactly FOUR
  entries and no `permission_request` key; a `permission_request` payload routed through
  `evaluateAndDispatch` produces zero drafts.
- Unit (`apps/agent/src/notifications/manager-session-name.test.ts`): permission-shaped
  fixtures replaced; suite stays green.
- Unit (`apps/agent/src/routes/notifications.test.ts` or sibling): a `/notifications/send`
  payload carrying `session_name`/`session_id` threads both to `manager.send()` extras; a
  payload without them produces today's exact shape (graceful degrade).
- Runtime (post-deploy): pipe one fake `PermissionRequest` payload (multi-question
  `tool_input.questions`) into `~/.claude/scripts/hooks/telemetry.sh` and confirm via
  `journalctl --user -u nexus-agent` + the `notifications` table that exactly ONE notification
  row lands (the rich body), ONE alert push fires, and the push title is
  `<project> · <session>` with a session deep-link.
- `bun test` over `apps/agent` is the batch gate.
