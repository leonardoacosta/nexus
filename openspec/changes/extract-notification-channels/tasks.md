---
stack: t3
---
<!-- beads:epic:nx-09shh -->
<!-- beads:feature:nx-2y7t5 -->

<!-- stack: one of t3 | cc-meta | effect | dotnet — see commands/apply/references/stacks.md § "Stack vocabulary crosswalk" for the full tasks.md-stack:/--stack-profile/detect_stack() mapping -->

# Implementation Tasks

## API Batch

- [ ] [1.1] Create `apps/agent/src/notifications/channels/tts.ts`: move the TTS/ElevenLabs handler + `setTtsDbHandle` out of `router.ts` unchanged in behavior. Factor the DB-row -> `tryLoadEncryptionKey` -> `decrypt` -> warn-fallback scaffold into one shared resolver reusable by Telegram (task 1.2); preserve re-query-per-dispatch (no cache) behavior verbatim. [beads:nx-zld7x]

- [ ] [1.2] Create `apps/agent/src/notifications/channels/telegram.ts`: move `sendTelegramNotification` out of `router.ts` unchanged in behavior, using the shared resolver from `channels/tts.ts` (task 1.1) instead of its own inline decrypt block. Preserve fail-open (`success: true` always) + re-query-per-dispatch (no cache) behavior. [beads:nx-3rfvu]
  - depends on: 1.1

- [ ] [1.3] Update `apps/agent/src/notifications/router.ts`: wire `CHANNEL_HANDLERS` to the two extracted handlers, delete the extracted code, re-export `setTtsDbHandle` + `resolveElevenLabsCredential` from `./channels/tts` (so `server.ts` needs no change). Keep routing policy (`findMatchingRule`, `withChannelTimeout`, `surfaceMissingHandler`, `routeNotificationParallel`, presence routing) in place. [beads:nx-oddnw]
  - depends on: 1.1, 1.2

- [ ] [1.4] Delete dead serial `routeNotification` from `router.ts`; remove its unused import at `apps/agent/src/notifications/manager.ts:20`. Update/delete `bun test` coverage in `router.test.ts`, `notifications.test.ts`, `reliability-regression.test.ts` exclusive to `routeNotification` — convert to `routeNotificationParallel` unless already covered. Run `bun test`, confirm green. [beads:nx-hec8r]
  - depends on: 1.3
