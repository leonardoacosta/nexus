## MODIFIED Requirements

### Requirement: CLAUDE.md SHALL accurately describe the shipped architecture

`CLAUDE.md` (project-level) SHALL describe the spine architecture: single nexus-agent on homelab, AF_UNIX socket-only ingestion, Swift+iOS+watchOS clients over Tailnet, no peer federation, no Mac daemons. The stale "Rust workspace" framing from earlier versions SHALL be removed.

#### Scenario: new operator reads CLAUDE.md and answers basic questions correctly
- **GIVEN** a new operator unfamiliar with Nexus reads CLAUDE.md
- **WHEN** asked "where does CC telemetry go?" and "how do I attach to a session from my phone?"
- **THEN** the answers ("AF_UNIX socket on homelab → cc_session_events table" and "tap Attach in iOS app → embedded SwiftTerm over SSH") are derivable from CLAUDE.md alone

### Requirement: README.md SHALL list the current service inventory

`README.md` SHALL accurately list every binary, every service unit, every client app, with current responsibilities and dependencies. Stale references to retired services (nexus-register, nexus-tui, Rust crates) SHALL be removed.

#### Scenario: README service inventory matches reality
- **GIVEN** the README is updated
- **WHEN** the listed binaries are compared against actual built artifacts
- **THEN** every listed binary exists and every existing binary is listed (no drift)
