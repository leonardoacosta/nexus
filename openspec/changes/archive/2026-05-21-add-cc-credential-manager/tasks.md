# Tasks: add-cc-credential-manager

- [x] 1.1 Drizzle migration: CREATE TABLE cc_profiles + RENAME credential_events TO cc_profile_events
- [x] 1.2 Implement cc-credential-manager.ts: read/write credentials.json + encrypt refresh tokens
- [x] 1.3 Implement OAuth refresh logic (proactive 5min before expiry)
- [x] 1.4 Implement rate-limit detection (429 monitoring) + swap
- [x] 1.5 Implement schema-drift detection for credentials.json format
- [x] 1.6 Implement Settings UI in nexus-mac to display profile status (read-only)
- [x] 1.7 Backup-before-write: every mutation writes a timestamped backup first
- [x] 1.8 Unit tests: refresh, swap, drift detection, backup rotation
- [x] 1.9 Integration test: mock CC OAuth endpoint, verify full lifecycle
