## Summary

Implement graceful shutdown for nexus-agent: on SIGTERM, drain active gRPC streams by sending a GoingAway message, wait up to 5 seconds for drain, then exit cleanly.

## Motivation

Currently when the agent receives SIGTERM (systemd restart, deploy), all connected gRPC clients see a connection reset. The TUI can't distinguish planned shutdown from a crash. Clients need a GoingAway signal to handle reconnection gracefully.

depends on: fix-port-binding

## Approach

1. Add `GoingAway` message to proto (additive — backward compatible)
2. Add `StatusTransition` message to proto (for session detail screen, used later)
3. Register SIGTERM handler using `tokio::signal::unix::signal(SignalKind::terminate())`
4. On SIGTERM: (a) stop accepting new connections, (b) broadcast GoingAway to all active StreamEvents streams, (c) start 5s drain timer, (d) on timeout or all streams closed, exit 0
5. Track active streams in a shared counter (AtomicUsize)

## Files Modified

- `proto/nexus.proto` — add GoingAway message, StatusTransition message
- `crates/nexus-agent/src/main.rs` — SIGTERM handler, shutdown coordinator
- `crates/nexus-agent/src/grpc.rs` — track active streams, send GoingAway on shutdown
