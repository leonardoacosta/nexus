---
status: draft
---

# Proposal: specs-tab-start-on-spec

## Why

The Swift dashboard's Specs tab is read-only: you can browse proposals, read
their markdown, and watch SSE transitions, but you cannot **start a session on
a spec**. Today the loop is broken at the hand-off: Leo sees `fix-foo` in
SpecsView, has to mentally context-switch to Sessions tab, run a separate
"Start Session" elsewhere, and remember which session was for which spec.

The Next.js Projects page already ships the **POST /session/start** endpoint
and a "Start Session" button (capability `session-launch`). This proposal
ports that pattern into SpecsView with **spec→session linkage** so the
dashboard tracks which sessions belong to which proposals, and adds a
**status toggle + read-only metadata view** so the proposal row's frontmatter
becomes interactive without bouncing to a terminal.

## What Changes

1. **New table `spec_sessions`** — a many-to-many join between specs (by
   `project + name` slug) and sessions (by `session_id`). Survives session
   close; the row stays so historical lookups ("which sessions touched
   spec X?") work. Indexed on both columns.

2. **POST /session/start extension** — optional `spec_slug` field. When
   present, the endpoint inserts a `spec_sessions` row after the tmux
   window spawn succeeds. The session itself is created identically; the
   link is a side effect.

3. **GET /specs/:project/:name/sessions** — returns the live + historical
   session rows linked to a spec. Used by SpecsView to render a session
   count chip on each proposal row.

4. **PATCH /specs/:project/:name/status** — flip status between
   `draft` / `approved`. Reuses the file-level approve/reject already
   shipped, but exposes a single endpoint that takes `{ status: "..."  }`
   so the UI doesn't need to know which side it's flipping to.

5. **SpecsView "Start Session" button** — per-row button. Clicking spawns
   a session in the spec's project directory and replaces the right pane
   (SpecDetailView) with a PTY split for the new session. The PTY shares
   the same right-pane state machine as Sessions tab's PTY but scoped
   inside SpecsView's HSplitView.

6. **SpecDetailView status toggle + metadata view** — read-only display
   of all frontmatter keys (capability, approved-by, approved-at,
   created-at, etc.) plus a single approve / unapprove / mark-draft
   toggle wired to PATCH /specs/:project/:name/status. No free-text
   editing in this scope.

## Context

- depends on: 
- touches: `packages/db/src/schema/specSessions.ts`, `packages/db/src/schema/index.ts`, `packages/db/drizzle/0034_add_spec_sessions.sql`, `apps/agent/src/routes/sessions.ts`, `apps/agent/src/routes/specs.ts`, `apps/agent/src/routes/specs/handlers-status.ts`, `apps/agent/src/services/session-spec-link.ts`, `apps/swift/nexus-mac/Sources/Dashboard/SpecsView.swift`, `apps/swift/nexus-mac/Sources/Dashboard/SpecDetailView.swift`, `apps/swift/NexusShared/Networking/NexusClient.swift`, `apps/swift/NexusShared/Models/SpecSummary.swift`, `apps/swift/NexusShared/Models/SpecSession.swift`

Companion to the just-archived `specs-tab-accordion-with-topology`. That
proposal shipped the read surface (grouping + topology); this one ships
the write surface (start, link, status flip).

The `session-launch` capability already documents the
`POST /session/start` contract for the Next.js dashboard. This spec
extends the same endpoint rather than introducing a parallel one — the
Swift client just becomes a second caller. The `spec_sessions` table is
additive: nothing existing reads it yet, so the table+migration can land
without coordinating with other in-flight work.

Frontmatter editing in this scope is intentionally narrow (status toggle
only). Free-text YAML editing is a follow-up — capturing it here would
double the surface area and require schema-aware validation that
doesn't exist yet.

## Risk

- **Tmux orphan sessions.** A user can click "Start Session" repeatedly
  on the same spec. Each click spawns a real tmux window. Mitigation:
  the button reads the live `spec_sessions` count and disables (with a
  tooltip showing the existing session IDs) when ≥1 session is already
  linked and active. The user can still attach to the existing session
  via the PTY split.
- **PTY split state coupling.** SpecsView already has an HSplitView
  (proposal row list ↔ SpecDetailView). Replacing the right pane with
  PTY introduces a state-machine fork. Mitigation: model the right
  pane as an enum (`.detail(spec) | .pty(session)`) and never share
  rendering paths. Closing the PTY returns the right pane to the
  spec detail it was on before.
- **Status flip races.** Two clients flipping status concurrently could
  collide on the YAML splice. Mitigation: use the same atomic
  `.tmp + os.replace` pattern already shipped in `/triage` (commands/triage.md
  § "Atomic Frontmatter Write"). Last-writer-wins is acceptable for
  single-user interactive flow.
