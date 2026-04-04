# Change: Add Progress Events to Command Streaming

## Why
When Nova sends a long-running command (like `/apply`) via `SendCommand`, it collects all output
into a string and returns it only when the command finishes. Nova can't relay incremental progress
to Leo via Telegram. The TUI can stream because it renders `CommandOutput` chunks — but Nova's
tool model is request/response.

## What Changes
- Add `ProgressUpdate` variant to `CommandOutput` proto (phase name, percentage, summary line)
- Parse CC stream-json progress markers and emit them as `ProgressUpdate` events
- Nova can relay these to Telegram as edited messages showing live progress

## Impact
- Affected specs: `command-execution` (new capability spec)
- Affected code: `proto/nexus.proto`, `crates/nexus-agent/src/parser.rs`, `crates/nexus-agent/src/grpc.rs`
- Non-breaking: new oneof variant, existing consumers ignore unknown variants
