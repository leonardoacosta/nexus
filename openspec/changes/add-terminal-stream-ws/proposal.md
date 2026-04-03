# Add Terminal Stream WebSocket

## Why
The dashboard needs real-time terminal output to fulfill ship criterion #2 (stream real-time). Currently there is no way to observe a running CC session's terminal output from the web UI. A read-only WebSocket stream on the agent is the foundational transport for both viewing and later interactive control.

## What Changes
Add a WebSocket upgrade endpoint at `/sessions/{id}/stream` on the agent. The server captures PTY stdout bytes from the target CC session and broadcasts them as binary frames to all connected viewers, with JSON control frames for lifecycle events (session_ended, error). A 10K-line ring buffer provides scroll-back for late-joining clients. Keepalive ping/pong prevents stale connections.
