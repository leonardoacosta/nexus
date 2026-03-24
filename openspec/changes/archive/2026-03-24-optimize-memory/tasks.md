## 1. Profiling
- [ ] 1.1 Add jemalloc as global allocator with profiling feature
- [ ] 1.2 Run agent under heaptrack with 5 active sessions for 10 minutes
- [ ] 1.3 Document top 5 allocation sites with sizes

## 2. Stream Backpressure
- [ ] 2.1 Replace unbounded channels in event broadcasting with bounded (capacity: 1000)
- [ ] 2.2 Add backpressure handling: drop oldest events when buffer full (log warning)
- [ ] 2.3 Cap gRPC stream send buffers

## 3. Allocation Reuse
- [ ] 3.1 Reuse `sysinfo::System` instance across health checks (avoid re-allocation per poll)
- [ ] 3.2 Cache and reuse Docker ps JSON parsing buffer
- [ ] 3.3 Avoid cloning protobuf messages in event fan-out (use Arc)

## 4. Validation
- [ ] 4.1 Measure steady-state memory after 1 hour with 5 sessions: must be < 250M
- [ ] 4.2 Measure peak memory during burst registration of 10 sessions: must be < 500M
- [ ] 4.3 `cargo clippy && cargo test` passes
