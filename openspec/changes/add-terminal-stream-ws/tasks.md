## 1. WebSocket Server
- [ ] [1.1] Implement WebSocket upgrade handler for `/sessions/{id}/stream` [owner:agent]
- [ ] [1.2] Handle invalid session ID with 404 WebSocket close code [owner:agent]
- [ ] [1.3] Add keepalive ping/pong (30s interval, 10s timeout) [owner:agent]

## 2. PTY Capture
- [ ] [2.1] Implement PTY output capture (read from session terminal via `/proc/{pid}/fd/`) [owner:agent]
- [ ] [2.2] Add scroll-back ring buffer (10K lines, sent on initial connect) [owner:agent]

## 3. Fan-Out
- [ ] [3.1] Implement fan-out broadcaster to multiple connected clients [owner:agent]
- [ ] [3.2] Handle session end gracefully (send `session_ended` control frame to all viewers, close connections) [owner:agent]

## 4. Validation
- [ ] [4.1] Write integration tests: connect, receive output, verify frame ordering [owner:agent]
- [ ] [4.2] Write integration test: multiple viewers receive same output [owner:agent]
- [ ] [4.3] Write integration test: late-joining client receives scroll-back buffer [owner:agent]
