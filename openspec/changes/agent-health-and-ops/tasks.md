## 1. Health Collection

- [x] 1.1 Implement `collect_health()` in `crates/nexus-agent/src/health.rs` using sysinfo crate — populate MachineHealth struct (CPU%, RAM used/total, disk used/total, load avg, uptime)
- [x] 1.2 Add Docker container detection — shell out to `docker ps --format json`, parse results into `Vec<ContainerStatus>`, return `None` if Docker not available
- [x] 1.3 Add HTTP health endpoint on port 7401 — axum GET `/health` returning HealthResponse as JSON

## 2. Session Operations

- [x] 2.1 Implement `StopSession` gRPC RPC in `crates/nexus-agent/src/grpc.rs` — send SIGTERM to session PID, wait 10s, send SIGKILL if still running, return final session status
- [x] 2.2 Implement `StartSession` gRPC RPC in `crates/nexus-agent/src/grpc.rs` — validate tmux on PATH, spawn `tmux new-session -d -s nx-<short-id> -- claude [args]`, return session_id and tmux_session name
- [x] 2.3 Update registry in `crates/nexus-agent/src/registry.rs` to track managed sessions with tmux_session metadata

## 3. Integration

- [x] 3.1 Wire health HTTP server startup into `crates/nexus-agent/src/main.rs` (port 7401, separate from gRPC on 7400)
- [x] 3.2 Wire StopSession and StartSession RPCs into gRPC service impl
