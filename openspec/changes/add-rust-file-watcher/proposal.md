# Add Rust File Watcher

## Why
Nexus v2 reuses the proven Rust `notify`-based file watcher from v1 for detecting Claude Code session changes. Extracting it into a standalone binary with a JSON IPC protocol decouples it from the old Cargo workspace and lets the Bun agent spawn it as a subprocess.

## What Changes
Extract the `notify` watcher from `crates/nexus-agent/src/watcher/` into `packages/watcher` as a standalone Rust binary. Define a newline-delimited JSON IPC protocol over stdin/stdout for bidirectional communication (watch commands in, session events out). Add a Cargo build script and integration tests.

## Specs
See specs/ directory (if applicable).
