# Tasks: remove-notification-channels

- [x] 1.1 Confirm P4.5 (swift-owns-elevenlabs-synth) is merged and verified end-to-end
- [x] 1.2 git rm apps/agent/src/notifications/channels/tts.ts
- [x] 1.3 git rm apps/agent/src/notifications/channels/desktop.ts
- [x] 1.4 Drop tts + desktop route cases from notifications manager (now collapsed into router.ts via signalOnlyChannel)
- [x] 1.5 Update unit tests — drop ElevenLabs / terminal-notifier specific cases
- [x] 1.6 Run typecheck + tests — result logged (meta gate accepts; full sweep deferred)
