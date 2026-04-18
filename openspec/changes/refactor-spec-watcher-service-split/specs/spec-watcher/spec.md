## ADDED Requirements

### Requirement: Module decomposition by concern
The spec-watcher capability MUST be implemented as a directory of concern-specific modules (`apps/agent/src/services/spec-watcher/`) rather than a single file. No file in the decomposition MAY exceed 250 lines.

#### Scenario: A new contributor opens the codebase
- **GIVEN** the spec-watcher feature is implemented
- **WHEN** the contributor inspects `apps/agent/src/services/`
- **THEN** they find a `spec-watcher/` directory with files named for concerns (constants, parser, poller, watcher, tts, index) rather than a single 707-line file

### Requirement: Pure parser layer
Parsing logic for spec event streams MUST live in `spec-watcher/parser.ts`, a module with no side effects — no subprocess spawning, no filesystem watching, no network I/O, no TTS.

#### Scenario: Unit test runs without subprocess
- **GIVEN** a JSON snapshot of `openspec list` output
- **WHEN** a unit test calls the parser directly (parseSpecList, processProjectSpecs)
- **THEN** no subprocess is spawned, no filesystem is watched, and the test returns a deterministic SpecSnapshot in under 50ms

### Requirement: Consumer API stability
The public exports of the spec-watcher module (including `startSpecWatcher`, `parseSpecList`, and any test-only hooks such as `_getWatchDegradedForTest` and `_projectState`) MUST remain importable from the same specifier they were before the split. Consumers MUST NOT need to update import paths.

#### Scenario: Existing consumer imports are unchanged
- **GIVEN** a file that imports from `@/services/spec-watcher` (or the equivalent relative path)
- **WHEN** the split is complete
- **THEN** the import resolves to the lifecycle index module and returns the same symbols as before the split
