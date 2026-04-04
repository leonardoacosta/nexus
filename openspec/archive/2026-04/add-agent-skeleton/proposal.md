# Add Agent Skeleton

## Why
The Bun agent is the core daemon running on each dev machine. Before any session detection or health monitoring can be built, the agent needs a working HTTP server with a health endpoint and a proven binary compilation path via `bun build --compile`.

## What Changes
Create a Bun HTTP server in `apps/agent` that listens on port 7400, serves a `/health` endpoint returning hostname and uptime (stubbed system metrics), includes CORS middleware for Tailscale origins, structured JSON logging, and a compile script producing a standalone `nexus-agent` binary.

## Specs
See specs/ directory (if applicable).
