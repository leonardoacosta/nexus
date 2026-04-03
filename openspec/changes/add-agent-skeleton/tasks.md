## 1. HTTP Server
- [ ] [1.1] Create Bun HTTP server with Bun.serve() and route dispatch in apps/agent/src/server.ts [owner:engineer]
- [ ] [1.2] Implement /health endpoint returning { hostname, uptime_seconds, cpu_percent, ram_percent, disk_percent, docker_containers } with stubbed system metrics [owner:engineer]
- [ ] [1.3] Add CORS middleware allowing Tailscale origins [owner:engineer]

## 2. Logging
- [ ] [2.1] Add structured JSON logging via @nexus/core logger utility [owner:engineer]

## 3. Compilation
- [ ] [3.1] Add bun build --compile script producing standalone nexus-agent binary [owner:engineer]
- [ ] [3.2] Verify compiled binary runs standalone and serves /health [owner:engineer]

## 4. Testing
- [ ] [4.1] Write tests for /health endpoint using Bun test runner [owner:engineer]
- [ ] [4.2] Write test verifying CORS headers are set correctly [owner:engineer]
