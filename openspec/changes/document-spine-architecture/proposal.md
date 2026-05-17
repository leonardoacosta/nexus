# Proposal: Document the spine architecture officially

## Change ID
`document-spine-architecture`

## Phase
P6 final-cleanup (parent: spine-migration · nx-ma6h8 · feature: nx-0taq8)

## Summary
Update CLAUDE.md + README.md to reflect the shipped spine architecture. Capture the spine-migration lessons in the eventual COMPLETION.md when this phase archives.

## Context
- Updates: `CLAUDE.md` (currently describes stale Rust crate architecture)
- Updates: `README.md` (architecture diagram + service inventory)
- Reference: `docs/nexus-topology.html` + `docs/nexus-evolution.html` (the source docs)
- Creates: `docs/plan/spine-migration/COMPLETION.md` (when the phase archives via /plan:advance)

## Motivation
CLAUDE.md is currently stale ("Rust workspace" framing from before the Bun migration). After spine-migration ships, the next operator deserves accurate baseline docs.

## Requirements

### Requirement: CLAUDE.md SHALL describe the spine architecture

CLAUDE.md's Architecture section SHALL describe: single nexus-agent on homelab, AF_UNIX socket ingestion, Swift+iOS+watchOS clients over Tailnet, no peer federation, no Mac daemons.

### Requirement: README.md SHALL list current service inventory

README.md SHALL accurately list every binary, every service unit, every client app, with their current responsibilities and dependencies.

#### Scenario: a new operator reads CLAUDE.md and understands the system
- **WHEN** someone unfamiliar with Nexus reads CLAUDE.md
- **THEN** they can correctly answer: "where does CC telemetry go?" and "how do I attach to a session from my phone?"
