# Implementation Tasks

<!-- beads:epic:nexus-mce7 -->

## API Batch

- [ ] [1.1] [P-1] Add SessionSummary variant to SocketEvent enum in socket_event.rs with tool_counts (HashMap), failure_count, compaction_count, agent_spawns, duration_ms, model, session_id, project fields [owner:api-engineer] [beads:nexus-fi0q]
- [ ] [1.2] [P-1] Add session summary storage field to SessionRegistry (Option<SessionSummary> per session entry) [owner:api-engineer] [beads:nexus-s59m]
- [ ] [1.3] [P-2] Add hooks_handler function in http_handlers.rs that deserializes POST body, dispatches on hook_event_name or event field, calls existing session_start/stop/failure handlers [owner:api-engineer] [beads:nexus-klkc]
- [ ] [1.4] [P-2] Register POST /hooks route in main.rs router [owner:api-engineer] [beads:nexus-kdtt]
- [ ] [1.5] [P-3] Handle session_summary event in hooks_handler: store summary in SessionRegistry, handle pending summaries for unknown sessions with 5-min TTL cleanup [owner:api-engineer] [beads:nexus-khxc]

## Validation Batch

- [ ] [2.1] Test POST /hooks with SessionStart payload returns 200 and registers session [owner:api-engineer] [beads:nexus-6oyc]
- [ ] [2.2] Test POST /hooks with StopFailure payload returns 200 and triggers notification [owner:api-engineer] [beads:nexus-kalf]
- [ ] [2.3] Test POST /hooks with session_summary payload returns 200 and stores summary [owner:api-engineer] [beads:nexus-uc35]
- [ ] [2.4] Test POST /hooks with malformed JSON returns 400 [owner:api-engineer] [beads:nexus-qrol]
- [ ] [2.5] Test POST /hooks with unknown event type returns 200 with ignored flag [owner:api-engineer] [beads:nexus-36lr]
- [ ] [2.6] cargo build and cargo clippy pass with no warnings [owner:api-engineer] [beads:nexus-8nua]
