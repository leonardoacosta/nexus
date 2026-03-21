## 1. Protobuf Definitions

- [x] 1.1 Create `proto/nexus.proto` with package `nexus.v1`
- [x] 1.2 Define enums: `SessionStatus`, `SessionType` (MANAGED, AD_HOC)
- [x] 1.3 Define messages: `Session`, `SessionId`, `SessionFilter`, `SessionList`
- [x] 1.4 Define messages: `StartSessionRequest`, `StartSessionResponse`, `StopResult`
- [x] 1.5 Define messages: `EventFilter`, `SessionEvent` (oneof payload with SessionStarted, HeartbeatReceived, StatusChanged, SessionStopped)
- [x] 1.6 Define messages: `MachineHealth`, `HealthResponse`
- [x] 1.7 Define `NexusAgent` service with RPCs: `GetSessions`, `GetSession`, `StartSession`, `StreamEvents`, `StopSession`

## 2. Workspace Dependencies

- [x] 2.1 Add `tonic`, `prost` to `[workspace.dependencies]` in root `Cargo.toml`
- [x] 2.2 Add `tonic-build`, `prost-build` to `[workspace.dependencies]` in root `Cargo.toml`

## 3. nexus-core Build Configuration

- [x] 3.1 Add `tonic`, `prost` to `[dependencies]` in `crates/nexus-core/Cargo.toml`
- [x] 3.2 Add `tonic-build` to `[build-dependencies]` in `crates/nexus-core/Cargo.toml`
- [x] 3.3 Create `crates/nexus-core/build.rs` that compiles `proto/nexus.proto` via tonic-build

## 4. Module Integration

- [x] 4.1 Add `pub mod proto` to `crates/nexus-core/src/lib.rs` using `tonic::include_proto!`

## 5. Verification

- [x] 5.1 `cargo build -p nexus-core` succeeds with generated protobuf types
- [x] 5.2 `cargo test` passes (no regressions in existing types)
