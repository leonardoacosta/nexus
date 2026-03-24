## Summary

Profile and reduce nexus-agent memory usage from ~450M steady-state to < 250M. The agent peaked at 1.3G which is excessive for a session tracker managing 5-10 sessions.

## Motivation

450M+ steady-state memory for a session tracker daemon is excessive even on homelab. The peak of 1.3G suggests unbounded buffers or allocation leaks. Target: < 250M steady-state, < 500M peak.

## Approach

1. Add jemalloc as the global allocator (better fragmentation behavior than system malloc)
2. Profile with `heaptrack` or DHAT to identify top allocators
3. Investigate likely culprits:
   - Unbounded gRPC stream buffers (protobuf messages accumulating)
   - Docker `docker ps` output caching (JSON parsing per-poll)
   - sysinfo collector retaining historical data
   - Protobuf message cloning in event broadcasting
4. Add backpressure to gRPC stream buffers (bounded channels)
5. Reuse allocations where possible (pre-allocated buffers for sysinfo)

## Files Modified

- `crates/nexus-agent/Cargo.toml` — add jemalloc dependency
- `crates/nexus-agent/src/main.rs` — set global allocator to jemalloc
- `crates/nexus-agent/src/grpc.rs` — add bounded channel for stream buffers
- `crates/nexus-agent/src/health.rs` — reuse sysinfo collector, avoid re-allocation
- `crates/nexus-agent/src/events.rs` — bounded broadcast channel for events
