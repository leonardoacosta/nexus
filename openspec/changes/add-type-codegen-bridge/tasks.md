# Implementation Tasks

<!-- beads:epic:nx-f2c3 -->

## Proto Batch

- [ ] [1.1] [P-1] Add `machine` (optional string) and `ended_at` (optional Timestamp) fields to proto `Session` message [owner:api-engineer] [beads:nx-nzgi]
- [ ] [1.2] [P-1] Restructure proto `MachineHealth`: replace flat scalars with nested `CpuInfo`, `RamInfo`, `DiskInfo` sub-messages; add `hostname`, `NetworkInfo`, `ProcessInfo`, `collected_at` [owner:api-engineer] [beads:nx-xeu4]
- [ ] [1.3] [P-2] Verify proto compiles: `cargo build -p nexus-core` succeeds after schema changes [owner:api-engineer] [beads:nx-3df8]

## Rust Batch

- [ ] [2.1] [P-1] Add `machine: Option<String>` and `ended_at: Option<DateTime<Utc>>` to Rust `Session` struct in `session.rs`; update `Session::new()` [owner:rust-engineer] [beads:nx-g6e6]
- [ ] [2.2] [P-1] Add `network: Option<Vec<NetworkInterface>>`, `processes: Option<ProcessSnapshot>`, `collected_at: Option<DateTime<Utc>>` to Rust `MachineHealth` in `health.rs` [owner:rust-engineer] [beads:nx-m61n]
- [ ] [2.3] [P-1] Update `proto_convert.rs` Session conversion: map `machine` and `ended_at` fields bidirectionally [owner:rust-engineer] [beads:nx-nrqp]
- [ ] [2.4] [P-1] Rewrite `proto_convert.rs` MachineHealth conversion: use nested proto messages instead of flat GB-aggregation; map `network`, `processes`, `collected_at` [owner:rust-engineer] [beads:nx-nclo]
- [ ] [2.5] [P-1] Make `AgentConfig.user` optional (`Option<String>`) and add `projects_dir: Option<String>` in Rust `config.rs` [owner:rust-engineer] [beads:nx-34a8]
- [ ] [2.6] [P-2] Update existing round-trip tests in `proto_convert.rs` for new Session fields and restructured MachineHealth [owner:rust-engineer] [beads:nx-q5o7]
- [ ] [2.7] [P-2] Add Rust config test that parses a shared TOML fixture (`tests/fixtures/agents.toml`) [owner:rust-engineer] [beads:nx-9dnd]
- [ ] [2.8] [P-2] Run `cargo test` and `cargo clippy` -- all pass [owner:rust-engineer] [beads:nx-ecqy]

## TS Codegen Batch

- [ ] [3.1] [P-1] Evaluate and install TS proto codegen tool (`ts-proto` or `buf`) as dev dependency [owner:ts-engineer] [beads:nx-dj7f]
- [ ] [3.2] [P-1] Create `proto:codegen` script in root `package.json` that generates TS types from `proto/nexus.proto` into `packages/core/src/generated/` [owner:ts-engineer] [beads:nx-gtez]
- [ ] [3.3] [P-1] Replace `packages/core/src/types/session.ts` with re-export from generated types [owner:ts-engineer] [beads:nx-rb31]
- [ ] [3.4] [P-1] Replace `packages/core/src/types/health.ts` with re-export from generated types [owner:ts-engineer] [beads:nx-6igk]
- [ ] [3.5] [P-1] Update `packages/core/src/index.ts` exports to re-export generated types [owner:ts-engineer] [beads:nx-mdd5]

## TS Config Batch

- [ ] [4.1] [P-1] Align TS Zod schema: make `self_name` optional (with default), make `user` match Rust optionality, add `projects_dir` if missing from Rust [owner:ts-engineer] [beads:nx-0w1m]
- [ ] [4.2] [P-2] Create shared TOML fixture at `tests/fixtures/agents.toml` [owner:ts-engineer] [beads:nx-9yvx]
- [ ] [4.3] [P-2] Add TS config test that parses the shared fixture and asserts field parity [owner:ts-engineer] [beads:nx-iwjv]

## Validation Batch

- [ ] [5.1] Run `cargo build` -- workspace compiles cleanly [owner:rust-engineer] [beads:nx-7ba1]
- [ ] [5.2] Run `cargo test` -- all tests pass including new round-trip tests [owner:rust-engineer] [beads:nx-0mlx]
- [ ] [5.3] Run `pnpm proto:codegen` -- generates without errors [owner:ts-engineer] [beads:nx-yqes]
- [ ] [5.4] Run `pnpm typecheck` -- no TS errors from generated type replacements [owner:ts-engineer] [beads:nx-wqdx]
- [ ] [5.5] Run `pnpm test` -- all TS tests pass including config fixture test [owner:ts-engineer] [beads:nx-pyca]
