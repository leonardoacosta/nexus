# fix-tts-announce-project-prefix — Change Proposal

## Summary

Fix TTS notification channel so audible announcements identify the sending project. Today the ElevenLabs POST drops the `notification.project` field and announces only the bare message body, while the parallel Slack channel and spec-watcher already prepend project context. Prepend `"<project>: <body>"` when the notification carries a project; fall through to bare body when absent. Also document the `project` field on the socket notification payload so external senders (`~/.claude` output styles, Nova) know to emit it.

## Motivation

**Observed:** When a notification payload reaches the Mac receiver, TTS announces only the message — the originating project is never spoken. Result: every notification sounds like it came from the same place.

**Root cause (verified):**

- `apps/agent/src/notifications/channels/tts.ts:30` — the ElevenLabs body is `text: notification.body,` — `notification.project` is ignored even when present.
- `apps/agent/src/notifications/channels/slack.ts:31` — Slack already renders `_Project: ${notification.project}_` when present. Parity gap between channels, not a schema gap.
- `apps/agent/src/services/spec-watcher/parser.ts:214-220` — existing project-prefix convention in the same package uses `${event.project}: <rest>` format. Same format chosen here for consistency.
- `apps/agent/src/services/socket-server/dispatcher.ts:108,139` — the dispatcher correctly reads `event.project` from inbound socket payloads and stores it on the `NotificationRow`. Receiver contract is already honoured; only the render layer drops it.

**Secondary finding:** Several senders (global CC output-style template, Nova integration) omit `project` from the socket payload entirely. That is out-of-repo code; this spec documents the expected payload shape on the nx side so external senders have a canonical contract to implement against. No `[user]` tasks — external updates land on their own cadence.

## Requirements (ADDED)

### TTS channel MUST render project prefix when present

When `sendTtsNotification` is invoked with a notification whose `project` field is a non-empty string, the `text` submitted to the ElevenLabs synthesis endpoint MUST be the concatenation `"<project>: <body>"`. The separator is a single colon followed by a single space. When `project` is `null`, `undefined`, or the empty string, the `text` MUST be the bare `body` with no prefix, no placeholder, and no attribution to `"nexus"`. The fallback path when `ELEVENLABS_API_KEY` is unset (console stub) MUST render the same composed text so logs and audio agree.

### Notification socket payload documents project field

The socket event schema for `event: "notification"` MUST document a `project?: string` field indicating the originating project slug. The dispatcher MUST read this field, pass it onto the `NotificationRow` unmodified, and MUST NOT substitute a default project name when the field is absent. Documentation MUST include a snippet showing how external senders (shell / Claude Code output styles / Nova) should populate the field — e.g. `basename "$PWD"` or an env-sourced identifier.

## Scope

**IN:**
- `apps/agent/src/notifications/channels/tts.ts` — compose `"<project>: <body>"` conditionally; both API-key and stub branches updated together.
- Notification socket payload schema documentation (TSDoc on the `SocketEvent` discriminated union variant for `notification`).
- Unit tests covering: project present, project null, project empty string, stub/no-key branch parity.

**OUT:**
- Slack channel (already correct at `channels/slack.ts:31`).
- External sender updates (`~/.claude/output-styles/*.md`, `~/dev/nv` Nova emitter). These are separate repos and will update against the documented payload contract on their own schedule.
- Voice selection, volume, or ElevenLabs model changes.
- New notification channels.
- Structural refactor of the notification router or channel registry.

## Impact

- `apps/agent/src/notifications/channels/tts.ts` — code change (2 call sites: ElevenLabs body + stub log).
- `apps/agent/src/services/socket-server/dispatcher.ts` or sibling types file — TSDoc on `project` field of the `notification` socket event.
- `apps/agent/src/notifications/channels/tts.test.ts` (new or extended) — unit coverage for the four branches.
- No DB changes, no migrations, no schema drift. No wire-level compatibility risk: payloads without `project` produce identical output to today's behaviour.

## Risks

| Risk | Mitigation |
|------|-----------|
| Existing test fixtures pass bare-body notifications without project → regression if anyone asserted on literal `text` string | Null-project path is bit-identical to current behaviour; only the `project !== null` branch is new |
| Senders continue to omit `project`, making the fix audibly invisible | Documented payload contract + motivation note in proposal. External senders update on own cadence; receiver-side fix is necessary but not sufficient and that is acknowledged |
| Voice cadence when project is long (e.g. `"nexus-status-dashboard: build complete"`) may sound clipped | Deferred. If this becomes a real complaint, add project-slug abbreviation table. Not in scope |
