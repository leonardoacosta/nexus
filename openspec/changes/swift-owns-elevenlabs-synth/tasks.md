# Tasks: swift-owns-elevenlabs-synth

- [ ] 1.1 Implement Keychain wrapper in NexusShared/Storage/
- [ ] 1.2 Implement ElevenLabsClient in NexusShared
- [ ] 1.3 Implement AVAudioPlayer playback in nexus-mac with ducking modes
- [ ] 1.4 Implement Settings UI in nexus-mac for Keychain key + voice ID + ducking
- [ ] 1.5 Modify agent notifications.ts: drop ElevenLabs call + audioBase64 field
- [ ] 1.6 Drop encryption/master.key code path used only for ElevenLabs
- [ ] 1.7 Drizzle migration: DROP TABLE elevenlabs_credentials
- [ ] 1.8 [user] Migration: export current key from DB, paste into Keychain via Settings UI
- [ ] 1.9 End-to-end test: fire notification → Mac speaker plays
