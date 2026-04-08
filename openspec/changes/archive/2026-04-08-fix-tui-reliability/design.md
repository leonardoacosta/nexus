## Context

The TUI is the primary interface for monitoring Claude Code sessions across machines. Network
conditions are inherently unreliable (Tailscale peer-to-peer, agents may restart, machines
sleep). The current code has two process-killing panics, an alert stream that permanently gives
up, and several UX gaps that leave users without feedback when things go wrong. This design
covers the non-obvious decisions: OTel graceful degradation, panic elimination pattern, reconnect
strategy, and buffer cap.

## Goals / Non-Goals

- Goals:
  - Eliminate all `.expect()` / `.unwrap()` calls in startup paths (OTel, logging init)
  - Replace panicking unwraps in `client.rs` with atomic `Option::take()`
  - Provide infinite reconnect with exponential backoff for both alert stream and session stream
  - Cap in-memory stream buffer at 10,000 lines
  - Surface agent offline state and data staleness to the user
  - Add fuzzy search and multi-select as growth features
- Non-Goals:
  - Changing the underlying gRPC/Axum transport protocol
  - Adding persistence for stream line history across process restarts
  - Supporting backoff configuration via TOML (hardcoded constants are sufficient)

## Decisions

### OTel Graceful Degradation

- Decision: Replace `.expect("failed to build OTel span exporter")` with `match`; on error,
  emit `tracing::warn!` and fall through to the non-OTel subscriber branch.
- Rationale: The OTel exporter failing (bad endpoint, network issue, TLS mismatch) is not a
  fatal condition for the TUI. The application can still run and log via `fmt` layer. Crashing
  on startup because of a misconfigured optional telemetry endpoint is unacceptable.
- Alternatives considered: Retry the exporter build in a background task. Rejected — adds
  complexity and the OTel layer cannot be added to an already-initialized subscriber.
- Code shape:

```rust
match opentelemetry_otlp::SpanExporter::builder()
    .with_tonic()
    .with_endpoint(endpoint)
    .build()
{
    Ok(exporter) => {
        // install OTel subscriber
    }
    Err(e) => {
        tracing::warn!(%e, "OTel exporter build failed; falling back to fmt-only tracing");
        // fall through to non-OTel subscriber
    }
}
```

### Logging Init — Directive Parsing

- Decision: Use `.unwrap_or_else(|_| Directive::default())` for the hardcoded
  `"nexus_tui=info"` directive parse. The fallback directive produces no filter, which means
  the default `EnvFilter` behaviour applies.
- Rationale: The hardcoded string `"nexus_tui=info"` should always parse correctly, but
  defensive code should not panic on a string that could theoretically be changed. Using a
  fallback is zero-cost at runtime and eliminates the panic path entirely.

### Connection Race — Option::take()

- Decision: Replace the `is_some()` guard + `as_mut().unwrap()` pattern with a single
  `Option::take()` call that atomically moves the client out of the `Option`.
- Rationale: Between `.is_some()` and `.unwrap()` in the same mutable borrow scope there is
  no actual race (single-threaded access within the async task), but the pattern is fragile
  and confuses the borrow checker. `take()` is idiomatic and self-documenting.
- Code shape:

```rust
// Before (fragile):
if agent.client.is_some() {
    let client = agent.client.as_mut().unwrap();
    // ... use client
}

// After (atomic, panic-free):
if let Some(client) = agent.client.as_mut() {
    // ... use client
}
```

Note: `as_mut()` inside `if let Some(...)` is preferred over `take()` here because we do not
want to move the client out permanently — only borrow it for the call. `take()` would
permanently clear the field. Use `take()` only in error paths where the agent is being
disconnected anyway.

### Reconnect Strategy

- Decision: Infinite reconnect with exponential backoff.
  - Initial interval: 1 second
  - Multiplier: 2×
  - Maximum interval: 120 seconds (alert stream) / 120 seconds (session stream)
  - No maximum attempt count
  - Manual reconnect resets the backoff to the initial interval
- Rationale: Developer machines sleep, agents restart, Tailscale peers go offline temporarily.
  A 5-attempt hard limit that gives up after ~2 minutes is worse than useless — users walk
  away from their machines expecting monitoring to resume but find a dead TUI on return. The
  only correct policy in a local-network peer-to-peer system is to keep trying.
- Reconnect state exposed via `tokio::sync::watch::Sender<StreamReconnectState>` so the UI
  can read it without polling.
- Alert stream: per-agent reconnect task; `AlertStreamStatus` reported per agent in `AppState`.
- Session stream: single reconnect loop; state shown in stream view header.

### Stream Buffer Cap

- Decision: Cap at 10,000 lines using `VecDeque<StreamLine>`; evict from the front when
  the cap is exceeded.
- Rationale: A long-lived session can produce tens of thousands of log lines. An unbounded
  `Vec` will grow without limit, eventually causing OOM or degraded render performance.
  10,000 lines covers many hours of typical Claude Code output and is well within RSS budget.
- No configuration knob: the cap is a compile-time constant. If users need more, that is a
  future feature.

### Agent Offline UI

- Decision: In the session list, inject a synthetic "Agent offline" row for each agent with
  `ConnectionStatus::Disconnected` or `ConnectionStatus::Failed`. The row shows the agent
  name, "offline", and the formatted `last_seen` timestamp (e.g. "last seen 4 min ago").
  The row uses dim foreground and is not selectable.
- Rationale: Silently hiding disconnected agents leaves users confused about missing sessions.
  A visible offline row communicates the state without requiring a separate health screen.

### Fuzzy Search

- Decision: Implement a simple prefix-contains matcher (case-insensitive `str::contains`
  after lowercasing both sides) as the first pass. Rank results by match position (earlier
  match = higher rank). Highlight matched characters using ratatui `Span` styling.
- Rationale: BM25 is significantly more complex to implement correctly and is overkill for
  matching 10–100 session/project names. A prefix-contains filter with position-based ranking
  delivers good UX with <50 lines of code. If the corpus grows, upgrade to a proper fuzzy
  library (e.g. `nucleo`) later.
- Alternatives considered: `nucleo` crate (production-grade fuzzy matching used by Helix).
  Rejected for now — adds a dependency and complexity for a feature that simple contains
  matching will handle adequately at the current scale.

## Risks / Trade-offs

- Infinite reconnect consumes a small amount of CPU for exponential backoff timers. Mitigation:
  backoff interval grows to 120 s maximum, so steady-state overhead is negligible.
- VecDeque eviction means users lose the oldest log lines if the TUI is left running on a
  very verbose session. Acceptable trade-off for bounded memory.
- `Option::take()` vs `as_mut()`: using `take()` in non-error paths would break the client
  field. Care must be taken to only take in disconnect/error paths. See code shape above.

## Migration Plan

No data migration required. All changes are in-process state. Deploy by replacing the binary.
Rollback: deploy previous binary.

## Open Questions

- Should the stream buffer cap be surfaced to the user ("Showing last 10,000 lines of N total")?
  Current decision: yes, show a dim status line at the top of the stream view when lines have
  been evicted.
- Should multi-select persist across navigation? Current decision: no, selection is cleared on
  screen transition.
