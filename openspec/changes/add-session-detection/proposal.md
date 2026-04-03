# Add Session Detection

## Why
The agent needs to detect and track Claude Code sessions in real time by consuming IPC events from the Rust file watcher. Without this bridge, the agent has no awareness of running sessions and the dashboard cannot show session data. This is the core data pipeline that everything downstream (API, dashboard, notifications) depends on.

## What Changes
Define the `Session` type in `@nexus/core`, implement an IPC subprocess manager that spawns the Rust file watcher and parses its JSON events into session state transitions (active, idle, ended). Add an in-memory session store with heartbeat-based idle detection (5-minute timeout) and watcher crash recovery with automatic restart.

## Specs
See specs/ directory (if applicable).
