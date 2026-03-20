## Context

The nexus-agent daemon already has a MachineHealth struct in nexus-core and sysinfo in workspace
deps. The gRPC server (from spec 3) will be running on port 7400. This spec adds health collection
logic, an HTTP health endpoint on a separate port (7401), and two new gRPC RPCs for session
lifecycle management.

## Goals / Non-Goals

- Goals: Health metrics collection, HTTP health endpoint, StopSession RPC, StartSession RPC,
  managed session tracking
- Non-Goals: Health history/time-series storage, session restart/retry logic, TUI rendering
  of health data (that is spec 7+)

## Decisions

- **HTTP health on port 7401**: Keeps health checks curl-friendly and decoupled from gRPC on 7400.
  Monitoring tools (uptime-kuma, curl scripts) can hit `/health` without gRPC clients.
  Alternative: serve health over gRPC only — rejected because curl/monitoring compatibility matters.

- **Docker detection via CLI**: Shell out to `docker ps --format json` rather than linking the
  Docker API crate. Keeps the binary small and avoids a heavy dependency. Returns `None` if docker
  is not on PATH or fails.
  Alternative: bollard crate — rejected for now, adds ~2MB to binary for a nice-to-have feature.

- **StopSession: SIGTERM then SIGKILL**: Standard Unix process lifecycle. 10 second grace period
  gives Claude Code time to flush state. Uses `nix::sys::signal` or `libc::kill` for signal delivery.
  Alternative: just SIGKILL — rejected, too aggressive, risks data loss.

- **StartSession tmux naming**: `nx-<first-8-chars-of-uuid>` provides uniqueness without
  excessive length. Tmux session names have a 256-char limit so this is safe.
  Alternative: sequential numbering — rejected, collides across restarts.

- **Managed session tracking**: Add a `managed: bool` field concept to the registry (or infer from
  `tmux_session.is_some()`). The Session struct already has `tmux_session: Option<String>` so no
  schema change needed — presence of tmux_session implies managed.

## Risks / Trade-offs

- **sysinfo accuracy**: CPU percent requires two samples with a delay (~200ms). The health endpoint
  should cache/refresh on an interval (e.g., every 5s) rather than computing per-request.
  Mitigation: background task refreshes MachineHealth into shared state.

- **Docker CLI availability**: If Docker is not installed, `docker ps` fails. Must handle gracefully
  with `None`.

- **tmux not on PATH**: StartSession must check for tmux before spawning. Return a clear gRPC
  error (FAILED_PRECONDITION) if missing.

## Open Questions

- None — design decisions are settled per PRD.
