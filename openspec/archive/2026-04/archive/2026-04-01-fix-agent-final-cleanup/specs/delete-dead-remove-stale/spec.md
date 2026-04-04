## REMOVED Requirements

### Requirement: Dead remove_stale Method
- The `remove_stale()` method at `registry.rs:93` and its `#[allow(dead_code)]` annotation are deleted. `detect_stale()` at `registry.rs:275` supersedes it with proper status transitions and event emission.

#### Scenario: remove_stale no longer exists
- **GIVEN** the registry module after cleanup
- **WHEN** searching for `remove_stale` in `registry.rs`
- **THEN** no such method exists
- **AND** `detect_stale` remains as the canonical stale-session handler
