## 1. Core Model
- [x] [1.1] Define notification model in `@nexus/core` (type, channel, project, priority, payload) [owner:agent]
- [x] [1.2] Implement notification buffer table in SQLite (queued, delivered, expired states) [owner:agent]

## 2. Meeting Detection
- [x] [2.1] Port meeting detection logic from Rust v1 (calendar integration or manual toggle) [owner:agent]
- [x] [2.2] Implement buffer/flush lifecycle (queue during meeting, flush on meeting end) [owner:agent]

## 3. Delivery Channels
- [x] [3.1] Implement desktop notification channel (node-notifier) [owner:agent]
- [x] [3.2] Implement TTS notification channel (ElevenLabs API) [owner:agent]
- [x] [3.3] Implement Slack webhook notification channel [owner:agent]

## 4. Routing
- [x] [4.1] Add project-aware routing rules (per-project channel and priority configuration) [owner:agent]

## 5. Validation
- [x] [5.1] Write tests for buffer/flush lifecycle (buffer during meeting, flush after) [owner:agent]
- [x] [5.2] Write tests for each delivery channel (mocked external services) [owner:agent]
- [x] [5.3] Write tests for project-aware routing [owner:agent]
