# Implementation Tasks

<!-- beads:epic:TBD -->

## API Batch

- [ ] [1.1] [P-1] Add `nix` crate with `signal` feature to `crates/nexus-agent/Cargo.toml` [owner:api-engineer]
- [ ] [1.2] [P-1] Replace `std::process::Command::new("kill").args(["-TERM", ...])` at line 172 with `nix::sys::signal::kill(Pid::from_raw(pid), Signal::SIGTERM)` [owner:api-engineer]
- [ ] [1.3] [P-1] Replace `std::process::Command::new("kill").args(["-0", ...])` at line 204 with `nix::sys::signal::kill(Pid::from_raw(pid), None)` for liveness probe [owner:api-engineer]
- [ ] [1.4] [P-1] Replace `std::process::Command::new("kill").args(["-KILL", ...])` at line 218 with `nix::sys::signal::kill(Pid::from_raw(pid), Signal::SIGKILL)` [owner:api-engineer]
- [ ] [1.5] [P-2] Map `Errno::ESRCH` to existing "process already gone" control flow in error handling [owner:api-engineer]
- [ ] [1.6] [P-2] Verify `cargo build -p nexus-agent` and `cargo test -p nexus-agent` pass [owner:api-engineer]
