---
name: audit-terminal-attach
description: Security and reliability audit of the Terminal Attach domain — PTY streaming, WebSocket session management, stream-manager.
---

# Terminal Attach Domain Audit

Audits the PTY streaming pipeline: session attach, WebSocket management, stream multiplexing, and cleanup.

---

## Phase 0 — Pre-flight

Load domain memory:
```
Task({
  subagent_type: "Explore",
  model: "haiku",
  prompt: "Read /home/nyaptor/dev/nx/.claude/audit/memory/terminal-attach-memory.md and return full contents. Return NO_HISTORY if empty."
})
```

Check tests:
```bash
find /home/nyaptor/dev/nx/apps/agent/src/terminal -name "*.test.ts" | xargs ls -la 2>/dev/null
find /home/nyaptor/dev/nx/apps/agent/src/terminal -name "*.test.ts" -exec head -20 {} \;
```

---

## Phase 1 — Source Code Review

```
Task({
  subagent_type: "Explore",
  model: "haiku",
  run_in_background: true,
  prompt: "Read these files in /home/nyaptor/dev/nx:
  - apps/agent/src/terminal/stream-manager.ts
  - apps/agent/src/terminal/pty-source.ts
  - apps/agent/src/terminal/stream.ts
  - apps/agent/src/terminal/interact.test.ts (if exists)
  - apps/agent/src/server.ts (WebSocket handling sections)
  Focus on: PTY cleanup on disconnect, resource leaks, auth checks, max concurrent streams, error propagation."
})
```

### Stream Manager (`terminal/stream-manager.ts`)

| # | Area | What to check |
|---|------|---------------|
| 1 | PTY process cleanup | PTY killed when WebSocket disconnects? |
| 2 | Concurrent streams | Max stream limit? Unbounded Map growth? |
| 3 | Stream ID generation | Collision-safe? UUID or sequential? |
| 4 | Error propagation | PTY crash → WebSocket close with error frame? |
| 5 | Memory leak | `pongDeadlines` Map — entries cleaned up? |

### PTY Source (`terminal/pty-source.ts`)

| # | Area | What to check |
|---|------|---------------|
| 1 | PTY spawn | Shell selection — configurable vs hardcoded? |
| 2 | Resize handling | `SIGWINCH` or resize message → PTY resize? |
| 3 | PTY death | Process exit propagated to stream? |
| 4 | Binary data | Non-UTF8 output handled? |

### Security

| # | Check | What to look for |
|---|-------|-----------------|
| 1 | Auth before attach | Any token/secret check before granting PTY? |
| 2 | Session ownership | Can agent A attach to session on agent B? |
| 3 | Command injection | User input passed to shell spawn? |
| 4 | Rate limiting | Max PTY sessions per connection? |

---

## Phase 2 — Reliability

| Check | What to verify |
|-------|----------------|
| WebSocket ping/pong | `PING_INTERVAL_MS = 30s`, `PONG_TIMEOUT_MS = 10s` — correctly cleans up dead connections? |
| PTY cleanup on server stop | Graceful shutdown kills all PTY processes? |
| Stream backpressure | Fast PTY output → slow WebSocket client → buffer overflow? |
| Reconnect | Client disconnect then reconnect to same stream — supported? |

---

## Evaluation Criteria

| Severity | Criteria |
|----------|----------|
| **P1** | PTY process leak, unauthorized attach, command injection |
| **P2** | No cleanup on disconnect, missing resize, connection leak |
| **P3** | Hardcoded shell, no rate limit, missing reconnect |
| **GCF** | Session recording/replay, multi-viewer streams |

---

## Findings Output

```bash
echo '{"phase":"terminal-attach","domain":"security","severity":"P1","description":"[description]","file_line":"[path:NN]","timestamp":"[ISO]","processed":false}' >> ~/.claude/scripts/state/nx-audit-findings.jsonl
```

---

## Output Format

```
## Terminal Attach Audit — [date]

### Security Summary
| Check | Status | Notes |
|-------|--------|-------|

### Reliability Summary
| Check | Status | Notes |
|-------|--------|-------|

### Issues Found
| Sev | Area | Description | file:line |
|-----|------|-------------|-----------|

## Summary
- Total issues: N (P1: N, P2: N, P3: N, GCF: N)
**ready for /apply-waves**
```
