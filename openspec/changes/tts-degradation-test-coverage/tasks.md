---
stack: t3
---
<!-- beads:epic:nx-09shh -->
<!-- beads:feature:nx-k3hbb -->

# Tasks — tts-degradation-test-coverage

## API Batch

- [x] 1.1 `channels/tts.test.ts`: add three degradation cases — fetch stub returns 500 ⇒ delivered signal-only (`audioBase64` absent, no throw); no ElevenLabs credential row ⇒ signal-only; voice-resolution throw ⇒ signal-only. Reuse the file's own mock pattern (spread-the-real-barrel nx-jlx1c, fetch stub, tmp `NEXUS_CONFIG_DIR`). If any case FAILS against current `tts.ts`, STOP and report — that is a bug finding, not a test to bend. [type:testing] [beads:nx-x0led]
  - touches: `apps/agent/src/notifications/channels/tts.test.ts`
- [x] 1.2 `routes/notifications-voices.test.ts`: add one case — `voice_id` longer than `VOICE_ID_MAX` ⇒ 400 whose error names the cap. Exemplar: the empty-voice_id case at :142. [type:testing] [beads:nx-okz0b]
  - touches: `apps/agent/src/routes/notifications-voices.test.ts`
- [x] 1.3 `notifications/notifications.test.ts`: delete the two `describe.skip` placeholder blocks (:31, :92 at base — 11 `expect(true)` bodies). Before deleting, confirm each named behavior is covered elsewhere (buffer.test.ts, manager.integration.test.ts, held-queue.test.ts, rules-engine.test.ts — grep the behavior phrase); any behavior NOT covered elsewhere gets a real test instead of deletion. [type:testing] [beads:nx-fwdhu]
  - touches: `apps/agent/src/notifications/notifications.test.ts`

## E2E Batch

- [ ] 2.1 Verify: `bun test apps/agent/src/notifications apps/agent/src/routes` (with `NEXUS_PG_TESTS=1` + `POSTGRES_URL` for PG suites) green; `grep -c 'expect(true)' apps/agent/src/notifications/notifications.test.ts` == 0; paste output. [type:testing] [beads:nx-zohg2]
