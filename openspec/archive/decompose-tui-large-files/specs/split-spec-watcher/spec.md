# Spec: split-spec-watcher

## MODIFIED Requirements

### Requirement: process_project_specs decomposed into per-event handlers
The `process_project_specs` function (~187 lines) in `crates/nexus-agent/src/services/spec_watcher.rs` MUST be refactored into a dispatcher that calls dedicated handler functions for each event type: hash change, task progress, new spec insertion, and spec removal detection.

#### Scenario: Event handling is functionally identical
- **GIVEN** the handler extraction is complete
- **WHEN** `process_project_specs` processes specs with hash changes, task progress, new specs, and removed specs
- **THEN** the same `SpecEvent` variants are emitted in the same order as before the refactor

#### Scenario: Each handler is self-contained
- **GIVEN** the 4 handler functions exist
- **WHEN** inspecting each handler
- **THEN** each handles exactly one event type, takes explicit parameters (db, project, spec data), and returns events — no shared mutable state between handlers
