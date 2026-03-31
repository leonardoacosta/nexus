# Proposal: fix(agent): move blocking docker detection inside spawn_blocking in health collector

## Change ID
`fix-blocking-docker-health`

## Summary
Move `detect_docker_containers()` calls inside `spawn_blocking` closures to prevent `std::process::Command::new("docker")` from blocking the tokio async runtime in the health collector loop.

## Context
- Extends: `crates/nexus-agent/src/health.rs`
- Related: The file already uses `spawn_blocking` for `sysinfo` refresh at line 67; docker detection should be colocated

## Motivation
`detect_docker_containers()` (lines 149-182) shells out to `docker ps` using `std::process::Command`, which blocks the calling thread. It is called in two places outside `spawn_blocking`: line 44 (initial snapshot) and line 60 (periodic refresh inside the async loop). The periodic call at line 60 is particularly impactful since it runs every `DOCKER_REFRESH_TICKS` cycles and blocks the health collector's tokio task. A `spawn_blocking` closure already exists at line 67 for `sysinfo` refresh -- the simplest fix is to move docker detection into that same closure.

## Requirements
### Req-1: Docker detection inside spawn_blocking
Move the `detect_docker_containers()` call at line 60 inside the existing `spawn_blocking` closure at line 67, so both sysinfo refresh and docker detection run on the blocking thread pool together.

### Req-2: Initial docker detection non-blocking
Move the initial `detect_docker_containers()` call at line 44 into a `spawn_blocking` closure as well, since it also blocks the async runtime during startup.

## Scope
- **IN**: Two `detect_docker_containers()` call sites in `health.rs` (lines 44 and 60)
- **OUT**: The `detect_docker_containers()` function itself remains synchronous (it runs inside `spawn_blocking`)

## Impact
| Area | Change |
|------|--------|
| `health.rs` line 44 | Initial docker detection wrapped in `spawn_blocking` |
| `health.rs` line 60 | Periodic docker detection moved inside existing `spawn_blocking` closure at line 67 |
| Runtime | Docker subprocess no longer blocks the tokio async executor |

## Risks
| Risk | Mitigation |
|------|-----------|
| Moving docker detection into the sysinfo `spawn_blocking` closure increases its duration | Docker ps typically completes in <100ms; sysinfo refresh is already ~200ms; combined time is acceptable for a health poll interval |
| Cached docker data becomes slightly more stale (refreshed with sysinfo rather than before it) | Negligible difference since both happen in the same tick cycle |
