# Add SQLite Store

## Why
The agent currently holds sessions in memory only -- a restart loses all history. A persistent SQLite store is needed for session history, health time-series (sparklines), and event audit trails. This is the data foundation that the session API and health history specs build on.

## What Changes
Create a per-agent SQLite database (via bun:sqlite, WAL mode) with three tables: sessions, health_snapshots, and session_events. Implement numbered SQL migration files with an auto-apply runner on startup, typed query helpers in `@nexus/core`, and retention cleanup (30 days health, 90 days events).

## Specs
See specs/ directory (if applicable).
