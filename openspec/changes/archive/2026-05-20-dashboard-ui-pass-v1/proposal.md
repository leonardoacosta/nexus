# Proposal: Dashboard UI polish — specs split-view, notifications layout, audio queue

## Change ID

dashboard-ui-pass-v1

## Why

Three Mac dashboard UX issues surfaced after the SSE + payload work
landed today (2026-05-20):

1. **SpecsView is single-column** — a flat list of project-grouped
   specs with no detail view. Clicking a spec does nothing. Operators
   can't read proposal/design/tasks content without leaving Nexus.app.

2. **NotificationsView body is squeezed** — `HSplitView` allocates
   260-320px to the settings pane on the right, leaving the body text
   wrapping aggressively at typical menu-bar window widths (~700px).
   Body content is the user's primary read; settings change rarely.

3. **TTS audio overlaps when notifications arrive in bursts** — the
   `/usr/bin/say` swap (`mac-tts-runtime-wire-up` archived 2026-05-20)
   replaced AVSpeechSynthesizer's built-in utterance queue with
   fire-and-forget Process invocations. Three rapid `nx_notify` calls
   spawn three parallel subprocesses talking over each other.

All three are Mac-side Swift work. Cohesive enough for one spec.

## What Changes

### Specs split-view + markdown renderer

- `SpecsView.swift` becomes an `HSplitView` (or `NavigationSplitView`):
  the existing project-grouped list on the left, a new
  `SpecDetailView` on the right.
- `SpecDetailView` accepts a selected `SpecSummary`, fetches markdown
  content via a new `NexusClient.fetchSpecContent(project, name, file)`
  HTTP call against the agent's `GET /specs/{project}/{name}/{file}`
  endpoint (proposal.md / design.md / tasks.md — three tabs in the
  detail view).
- Renderer: SwiftUI's `Text(try AttributedString(markdown:))` with
  `interpretedSyntax: .inlineOnlyPreservingWhitespace`. Bold, italic,
  inline code, links work; headings/code blocks render as plain text
  (acceptable for v1 — full block renderer can come later).
- Agent side: new route handler in `apps/agent/src/routes/specs.ts`
  serving the markdown file bytes after path sanitization (reject `..`,
  enforce `<root>/<project>/openspec/changes/<spec>/<file>.md`).

### NotificationsView bottom-toolbar layout

- Replace `HSplitView { historyPane, settingsPane }` with a vertical
  `VStack { historyPane, settingsToolbar }`.
- `settingsToolbar` is a horizontal compact row pinned to the bottom:
  Mode picker (Mix/Meet menu), Signal-only toggle, Suppression stepper
  (0m default), Ducking menu. ~44pt height.
- History pane gets the full window width — body text reads as
  intended.

### Audio serial queue

- Convert `SystemSpeechSynthesizer` to an `actor` with a single in-flight
  Process. Public `speak()` awaits the previous Process's exit before
  launching the next.
- Strict FIFO; no skip-on-clash. Three rapid notifications produce
  three sequential utterances over 3-5 seconds.
- Existing public signature (`speak(_ text: String, rate: Int = 175)`)
  unchanged.

## Context

- depends on: (none — mac-tts-runtime-wire-up archived 2026-05-20, agent-payload-completeness archived 2026-05-20)
- touches: `apps/swift/nexus-mac/Sources/Dashboard/SpecsView.swift`, `apps/swift/nexus-mac/Sources/Dashboard/SpecDetailView.swift`, `apps/swift/nexus-mac/Sources/Dashboard/NotificationsView.swift`, `apps/swift/NexusShared/Synthesis/SystemSpeechSynthesizer.swift`, `apps/swift/NexusShared/Networking/NexusClient.swift`, `apps/swift/NexusShared/Networking/NexusAggregateClient.swift`, `apps/agent/src/routes/specs.ts`, `apps/agent/src/services/spec-watcher/fs-snapshot.ts`, `apps/swift/NexusSharedTests/SystemSpeechSynthesizerTests.swift`, `apps/agent/src/routes/specs.test.ts`

## Motivation

The Specs tab is the most-touched surface in Nexus.app (Leo edits
specs throughout the day). A flat list without inline content forces
context-switching to terminal+editor. A markdown-rendered detail pane
turns Nexus.app into a true triage surface.

Notifications layout is a daily friction — body text getting truncated
on a small window happens dozens of times per day. Bottom toolbar
fixes the horizontal squeeze without losing settings access.

Audio overlap is the most visible quality issue right now. Leo
confirmed hearing the overlap in production today. Serial queue is
the standard fix.

## Locked Decisions

- **Markdown: AttributedString (built-in)** — no SPM dep. Limited
  block-level rendering acceptable for v1. Future spec can add
  MarkdownUI if heading/code-block fidelity matters.
- **Notifications: bottom toolbar** — body full-width, settings
  always visible but compact.
- **Audio: serial actor with strict FIFO** — predictable, no audio
  drops. Future spec can add bounded queue if burst events overwhelm.
- **Spec content endpoint: dedicated handler** — separate from
  `/specs` metadata for cacheability and path-sanitization isolation.

## Out of Scope

- Block-level markdown rendering (headings, code blocks, lists with
  proper styling). v1 ships AttributedString; full renderer is a
  follow-up spec.
- Spec editing from Nexus.app (read-only for now).
- Cross-spec search / filter UI.
- Notification body editing in-place.
- Audio voice picker per-project / per-channel.
