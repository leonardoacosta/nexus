# Change: Split receiver/service.rs god module into focused sub-modules

## Why
`crates/nexus-agent/src/services/receiver/service.rs` is 3,205 lines containing HTTP routing, TTS orchestration, notification delivery, mode management, iMessage handling, socket listening, state management, and 40+ functions in a single file. This makes the module difficult to navigate, test in isolation, and modify without unintended side effects.

## What Changes
- Extract HTTP request parsing and routing into `http_router.rs`
- Extract TTS orchestration logic into `tts_orchestrator.rs`
- Extract `ReceiverState` and mode/type management into `state.rs`
- Extract socket message handling and connection logic into `socket.rs`
- Keep `service.rs` as a thin orchestrator wiring sub-modules together via the `Service` trait impl

## Impact
- Affected specs: none (pure structural refactor, no behavior change)
- Affected code: `crates/nexus-agent/src/services/receiver/service.rs` (3,205 lines) split into 4-5 focused modules
- The receiver directory already has 14 files — this refactor continues the existing pattern of domain-specific modules
