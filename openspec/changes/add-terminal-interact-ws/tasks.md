## 1. Bidirectional Handler
- [x] [1.1] Implement bidirectional WebSocket handler at `/sessions/{id}/interact` [owner:agent]
- [x] [1.2] Implement PTY stdin write (forward raw bytes from client to PTY fd) [owner:agent]
- [x] [1.3] Handle control characters correctly (Ctrl+C = 0x03, Ctrl+D = 0x04, etc.) [owner:agent]

## 2. Resize and Mutex
- [x] [2.1] Implement resize event handling (parse JSON `{ "type": "resize", "cols", "rows" }`, send SIGWINCH) [owner:agent]
- [x] [2.2] Add interactive session mutex (one writer at a time, many concurrent readers) [owner:agent]
- [x] [2.3] Handle writer disconnect gracefully (release mutex, revert to read-only for viewers) [owner:agent]

## 3. Performance
- [x] [3.1] Measure and optimize keypress-to-screen latency (target <100ms on Tailscale) [owner:agent]

## 4. Validation
- [x] [4.1] Write integration tests: connect, send input bytes, verify echo on stdout [owner:agent]
- [x] [4.2] Write integration test: resize event triggers SIGWINCH on PTY [owner:agent]
- [x] [4.3] Write integration test: second interactive client is rejected while mutex held [owner:agent]
- [x] [4.4] Write integration test: writer disconnect releases mutex for next client [owner:agent]
