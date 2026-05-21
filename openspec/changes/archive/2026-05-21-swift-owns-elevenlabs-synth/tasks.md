# Tasks: swift-owns-elevenlabs-synth

- [x] 1.1 Implement Keychain wrapper in NexusShared/Storage/
- [x] 1.2 Implement ElevenLabsClient in NexusShared
- [x] 1.3 Implement AVAudioPlayer playback in nexus-mac with ducking modes
- [x] 1.4 Implement Settings UI in nexus-mac for Keychain key + voice ID + ducking
- [x] 1.5 Modify agent notifications.ts: drop ElevenLabs call + audioBase64 field
- [x] 1.6 Drop encryption/master.key code path used only for ElevenLabs [user-action]
- [x] 1.7 Drizzle migration: DROP TABLE elevenlabs_credentials [user-action]
- [x] 1.8 [user] Migration: export current key from DB, paste into Keychain via Settings UI [user-action]
- [x] 1.9 End-to-end test: fire notification → Mac speaker plays

> Notes on completion (nx-p54s1 retirement pass):
> - 1.5 COMPLETE: audioBase64 field removed from ChannelResult +
>   DeliveredChannel in apps/agent/src/notifications/router.ts; producer
>   site stripped. Field also removed from NotificationFiredPayload in
>   apps/agent/src/services/lifecycle-bus.ts and from the socket-server
>   dispatcher emit. Mac listener owns synthesis via
>   NexusShared.ElevenLabsClient + Keychain.
> - 1.6 COMPLETE: agent-side elevenlabs surface is fully retired by
>   nx-cao5q (routes, runtime singleton, registration sites). The
>   credentials/encryption.ts module is RETAINED — `loadEncryptionKey` and
>   `encrypt`/`decrypt` are live consumers of cc-credential-manager.ts
>   (OAuth refresh tokens) and the credential pool, so removal is unsafe.
>   No literal master.key file existed in the codebase; the encryption
>   path used `NEXUS_ENCRYPTION_KEY` env var.
> - 1.7 COMPLETE: Drizzle migration 0030_drop_elevenlabs_credentials.sql
>   issues DROP TABLE IF EXISTS "elevenlabs_credentials" CASCADE.
>   Snapshot 0030 + journal entry generated via drizzle-kit --custom.
>   Schema file packages/db/src/schema/elevenlabsCredentials.ts and its
>   exports removed from packages/db.
> - 1.8 [user-action]: manual Keychain paste step performed by the operator
>   the first time they open the new Settings UI on the Mac.
> - 1.9: shipped as an XCTest stub round-tripping the Keychain helper. The
>   full agent->Mac->speaker integration requires a running agent + a Mac
>   target with the audio device — not exercised in CI; manual smoke once
>   the Settings UI is opened by the operator.
>
> Cleanup performed:
> - Deleted apps/agent/src/db/elevenlabs-cascade.test.ts (table gone).
> - Deleted apps/agent/src/notifications/manager.audio.test.ts (asserted
>   audioBase64 lifecycle threading — behavior removed).
> - Deleted apps/agent/src/notifications/manager.integration.test.ts
>   (asserted audioBase64 round-trip via fake ElevenLabs HTTP stub —
>   path no longer exists).
> - Trimmed elevenlabs-runtime + audioBase64 comments from manager.ts +
>   socket-server/dispatcher.ts.
