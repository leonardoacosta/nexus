## ADDED Requirements

### Requirement: nexus-agent SHALL remain stable under heavy concurrent session load

The agent process MUST NOT crash (SIGABRT/SIGILL) under sustained heavy concurrent
multi-session load. Memory usage approaching the systemd `MemoryMax` cap MUST be diagnosable
(structured logging of memory pressure) rather than terminating via an uncaught native-level
abort with no diagnostic trail.

#### Scenario: Memory pressure is logged before a potential crash

- **GIVEN** the agent process's memory usage crosses 90% of its configured `MemoryMax`
- **WHEN** the next memory-sampling tick runs
- **THEN** a structured WARN-level log entry is emitted recording current usage and the cap
- **AND** this log entry exists in the process's log history even if the process subsequently
  crashes, giving the next investigation a diagnostic trail the 2026-07-12 incident lacked
