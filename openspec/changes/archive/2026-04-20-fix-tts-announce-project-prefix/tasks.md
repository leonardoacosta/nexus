# Implementation Tasks

<!-- beads:epic:nx-bujg -->

## API Batch

- [x] [1.1] [P-1] Update `apps/agent/src/notifications/channels/tts.ts` — compose `const text = notification.project ? \`${notification.project}: ${notification.body}\` : notification.body;` and use that composed value in BOTH the ElevenLabs POST body (line ~30) and the no-API-key stub log (line ~15). Do not substitute a default project name when `project` is null, undefined, or the empty string. [owner:api-engineer] [beads:nx-aljj]
- [x] [1.2] [P-2] Add TSDoc to the `notification` variant of the socket event discriminated union covering the `project?: string` field — intent (originating project slug), nullability (MAY be omitted / null / empty string — all equivalent), and an example snippet (`basename "$PWD"`). Source file is whichever type owns the `SocketEvent` union consumed by `apps/agent/src/services/socket-server/dispatcher.ts` (grep for the `event: "notification"` literal to locate). [owner:api-engineer] [beads:nx-nqia]

## E2E Batch

- [x] [2.1] [P-1] Unit test `tts.ts` — fixture: `notification.project = "nova"`, `notification.body = "build complete"`; mock `fetchWithTimeout`; assert the POST body `text` field equals `"nova: build complete"`. [owner:e2e-engineer] [beads:nx-ospf]
- [x] [2.2] [P-1] Unit test `tts.ts` — fixture: `notification.project = null`; assert POST body `text` equals the bare `body` with no prefix and no substituted project name. [owner:e2e-engineer] [beads:nx-k091]
- [x] [2.3] [P-1] Unit test `tts.ts` — fixture: `notification.project = ""` (empty string); assert identical output to the null-project case. [owner:e2e-engineer] [beads:nx-p63t]
- [x] [2.4] [P-2] Unit test `tts.ts` stub path — unset `ELEVENLABS_API_KEY`; fixture with project present; assert the logged `body` field reflects the composed `"<project>: <body>"` so stub parity with the live path is enforced. [owner:e2e-engineer] [beads:nx-k5rv]
- [x] [2.5] [P-2] Unit test dispatcher — socket event with `project: "nova"` produces a `NotificationRow` whose `project === "nova"`; socket event without a `project` field produces a `NotificationRow` with `project === null`. [owner:e2e-engineer] [beads:nx-vx5f]
