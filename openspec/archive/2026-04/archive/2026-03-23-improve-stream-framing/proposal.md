# Change: Message Framing and Event Filtering in Stream View

## Why
The stream attach view mixes conversation content with system events (heartbeats, status changes)
in a flat log. User prompts, assistant responses, and lifecycle events are visually
indistinguishable at a glance. Competing tools (OpenCode, Toad) use clear visual separation
between message types with card-like framing and noise filtering.

## What Changes
- Add visual message framing: user messages get green left-border accent, assistant blocks get
  subtle visual grouping, tool calls remain as-is (already have icons)
- Filter system event noise: heartbeats already suppressed, now also suppress rapid status changes
  and move remaining events to status bar
- Add verbosity toggle: `v` cycles Minimal (chat only) → Normal (+ tools) → Verbose (+ all events)
- Add "── assistant ──" header matching the existing "── you ──" pattern
- Add blank line separators between message groups for visual breathing room

## Impact
- Affected specs: `stream-rendering` (modify capability spec)
- Affected code: `crates/nexus-tui/src/screens/stream.rs` (rendering), `crates/nexus-tui/src/app.rs` (event filtering, mode state)
- No new dependencies
