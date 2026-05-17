# Tasks: add-cc-credential-manager

- [ ] 1.1 Drizzle migration: CREATE TABLE cc_profiles + RENAME credential_events TO cc_profile_events
- [ ] 1.2 Implement cc-credential-manager.ts: read/write credentials.json + encrypt refresh tokens
- [ ] 1.3 Implement OAuth refresh logic (proactive 5min before expiry)
- [ ] 1.4 Implement rate-limit detection (429 monitoring) + swap
- [ ] 1.5 Implement schema-drift detection for credentials.json format
- [ ] 1.6 Implement Settings UI in nexus-mac to display profile status (read-only)
- [ ] 1.7 Backup-before-write: every mutation writes a timestamped backup first
- [ ] 1.8 Unit tests: refresh, swap, drift detection, backup rotation
- [ ] 1.9 Integration test: mock CC OAuth endpoint, verify full lifecycle
