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

> Notes on deferred user-actions:
> - 1.5 is COMPLETE: the agent's tts channel (apps/agent/src/notifications/channels/tts.ts)
>   is now signal-only — the manager no longer threads audioBase64 onto
>   NotificationFired (apps/agent/src/notifications/manager.ts). The Mac
>   listener calls NexusShared.ElevenLabsClient + AVAudioPlayer locally.
> - 1.6 [user-action]: the `apps/agent/src/credentials/elevenlabs-runtime.ts`
>   singleton (master.key + DB handle) is still consumed by the legacy
>   `/elevenlabs-credentials` and `/elevenlabs-voices` HTTP routes. Those
>   routes are themselves orphaned now that the Mac owns synthesis, but
>   ripping them out is a follow-up change (touches dashboard UI). Plan:
>   retire the HTTP routes in a sibling spec, then delete elevenlabs-runtime
>   and the encryption-only path through credentials/encryption.ts.
> - 1.7 [user-action]: dropping `elevenlabs_credentials` requires retiring
>   the consumers in 1.6 first. Migration intentionally NOT generated this
>   wave — the table is harmless dead weight until the routes go.
> - 1.8 [user-action]: manual Keychain paste step performed by the operator
>   the first time they open the new Settings UI on the Mac.
> - 1.9: shipped as an XCTest stub round-tripping the Keychain helper. The
>   full agent->Mac->speaker integration requires a running agent + a Mac
>   target with the audio device — not exercised in CI; manual smoke once
>   the Settings UI is opened by the operator.
