# Implementation Tasks

<!-- beads:epic:nx-8pz -->

## API Batch

- [ ] [1.1] [P-1] Add `is_meeting_active()` convenience method to SuppressionChecker that calls `is_video_call_active()` [owner:api-engineer] [beads:nx-bl1]
- [ ] [1.2] [P-1] Add `flush_as_summary(&mut self) -> Option<String>` to NotificationBatchBuffer — groups queued messages by type and returns a concise summary string [owner:api-engineer] [beads:nx-c3i]
- [ ] [1.3] [P-1] Add `meeting_active: bool` field to ReceiverState and setter/getter methods [owner:api-engineer] [beads:nx-rq5]
- [ ] [1.4] [P-2] Add meeting detection polling task in ReceiverService::start() — 30s interval, bridges SuppressionChecker → focus_session → flush_as_summary on transition [owner:api-engineer] [beads:nx-zqj]
- [ ] [1.5] [P-2] Wire `meeting_active` into `/status/notifications` response in http_router.rs [owner:api-engineer] [beads:nx-jzt]
- [ ] [1.6] [P-2] Reset `focus_session` and `meeting_active` to false on ReceiverService startup (crash recovery) [owner:api-engineer] [beads:nx-lte]

## E2E Batch

- [ ] [2.1] Unit test: flush_as_summary with mixed notification types produces correct summary string [owner:api-engineer] [beads:nx-uzk]
- [ ] [2.2] Unit test: flush_as_summary with single notification returns original message [owner:api-engineer] [beads:nx-5qr]
- [ ] [2.3] Unit test: flush_as_summary with empty queue returns None [owner:api-engineer] [beads:nx-pqf]
- [ ] [2.4] Unit test: meeting detection state transitions (inactive→active, active→inactive) [owner:api-engineer] [beads:nx-1km]
