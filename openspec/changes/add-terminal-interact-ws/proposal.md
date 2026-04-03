# Add Terminal Interact WebSocket

## Why
Ship criterion #3 requires sending input to remote CC sessions. Read-only streaming (Wave 4.1) lets users observe but not control sessions. A bidirectional WebSocket relay enables full interactive terminal control from the dashboard, which is the core differentiator of Nexus over simple monitoring tools.

## What Changes
Add a WebSocket upgrade endpoint at `/sessions/{id}/interact` that extends the stream protocol with write capability. Clients send raw stdin bytes and resize control frames; the server writes to the PTY's stdin fd and delivers SIGWINCH on resize. An interactive session mutex ensures only one writer at a time while allowing unlimited read-only viewers. Target latency is under 100ms on Tailscale.
