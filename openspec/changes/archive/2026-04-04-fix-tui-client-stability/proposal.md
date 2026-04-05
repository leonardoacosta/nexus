# Proposal

## Change ID
fix-tui-client-stability

## Summary
Harden the TUI client against panics, terminal resize breakage, and silent stream disconnects that currently cause the user to lose session visibility without any feedback.

## Context
The TUI client (`nexus-tui`) polls agents over HTTP and streams session events over gRPC. Three structural defects degrade reliability: (1) a `.unwrap()` on `reqwest::Client::builder().build()` inside `tokio::select!` at main.rs:735 will panic the entire polling task if the TLS backend is unavailable; (2) the event loop discards `Event::Resize` events at main.rs:564-578, so the layout freezes at the initial terminal dimensions; (3) session streams do not reconnect after a clean or unexpected disconnect (stream.rs:88-91), leaving the StreamAttach view stale with no indication. Additionally, RPC errors for project listing are swallowed and return empty results (main.rs:815-819), magic numbers govern timing behaviour (main.rs:445,537,549), and the stream message channel is unbounded-equivalent (256 fixed) with no flow-control for slow TUI renders (stream.rs:53).

## Motivation
- **P1 (nx-3te5):** The `unwrap()` on client construction kills the entire background polling task. If the OS TLS stack is momentarily unavailable the TUI becomes a frozen shell with no way to recover short of a restart.
- **P2 (nx-55hx):** Resize events are silently discarded. Users who resize their terminal get a broken layout — widgets overflow or are clipped — with no remedy.
- **P2 (nx-agrb):** Streams never reconnect. A transient network blip or agent restart leaves the StreamAttach view permanently stale.
- **P3 backlog items:** Silent RPC errors, magic numbers, and unbounded channel backpressure are addressable in the same pass.

## Requirements
1. **Req-1: Panic-safe HTTP client construction** — The `reqwest::Client` SHALL be constructed once at startup, before the polling loop begins. Construction errors SHALL be propagated with `?` (not `.unwrap()`), terminating the task cleanly. The single client instance SHALL be reused across all loop iterations.
2. **Req-2: Terminal resize handling** — The event loop SHALL handle `Event::Resize(cols, rows)` by updating the terminal layout dimensions and triggering an immediate redraw.
3. **Req-3: Stream auto-reconnect** — When a session stream disconnects (clean end or transport error), the streaming task SHALL attempt reconnection with exponential backoff (base 1s, max 30s), up to 5 attempts. After exhausting retries the TUI SHALL surface an error state in the StreamAttach view.
4. **Req-4: Error states surfaced in UI** — RPC failures (including `list_projects`) SHALL send an error result to the UI rather than silently returning an empty value. The StreamAttach view SHALL display a visible error banner when max reconnect attempts are exhausted.
5. **Req-5: Named timing constants** — All magic numbers governing tick intervals, debounce windows, and heartbeat staleness thresholds SHALL be extracted to named `const` declarations with inline comments explaining their units and purpose.

## Scope
- `crates/nexus-tui/src/main.rs` — client construction, resize arm, polling loop error handling, constants
- `crates/nexus-tui/src/stream.rs` — reconnect loop, backpressure channel sizing
- No API changes; no schema changes; no new crates required

## Impact
- Affected specs: `specs/tui-client/spec.md`
- Affected code: `crates/nexus-tui/src/main.rs`, `crates/nexus-tui/src/stream.rs`
- No breaking changes to agent API or config format

## Risks
- Reconnect loop for stream.rs introduces new state (attempt counter, backoff timer) — must guard against infinite retry on permanent agent absence (mitigated by 5-attempt cap).
- Building `reqwest::Client` at startup rather than inline changes the failure mode from panic-at-runtime to startup error — acceptable, preferable.
- Resize handling triggers a full redraw; ensure redraw is cheap (ratatui renders are already frame-diffed).
