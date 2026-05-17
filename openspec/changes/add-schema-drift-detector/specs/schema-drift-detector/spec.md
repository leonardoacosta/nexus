## ADDED Requirements

### Requirement: hook payloads SHALL be fingerprinted on arrival

For each incoming hook payload, the drift detector SHALL compute a SHA-256 fingerprint of the sorted top-level key set. The fingerprint SHALL be persisted to the new `hook_schema_fingerprints` table keyed by `(event_type, fingerprint, first_seen, last_seen)`.

#### Scenario: known fingerprint updates last_seen
- **GIVEN** a fingerprint `abc...` for event_type `PreToolUse` already exists
- **WHEN** another PreToolUse payload arrives with the same key set
- **THEN** `last_seen` is updated; no event is emitted

### Requirement: new (event_type, fingerprint) pairs SHALL emit HookSchemaDrift

When the detector observes a new fingerprint for an `event_type`, it SHALL emit a `HookSchemaDrift` event to the lifecycle bus. Rate limit: at most one `HookSchemaDrift` event per `event_type` per hour.

#### Scenario: CC adds a new field
- **GIVEN** PreToolUse fingerprint `abc...` is known
- **WHEN** CC updates and PreToolUse arrives with an extra field (new fingerprint `def...`)
- **THEN** exactly one `HookSchemaDrift` event is emitted with `{event_type: 'PreToolUse', old_fingerprint: 'abc...', new_fingerprint: 'def...'}`

#### Scenario: rate limit suppresses repeats within the hour
- **GIVEN** a HookSchemaDrift was emitted 30 minutes ago for PreToolUse
- **WHEN** another novel PreToolUse fingerprint arrives in the same hour
- **THEN** no event is emitted; the fingerprint is persisted but the alert is suppressed
