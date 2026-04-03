## 1. Setup
- [ ] [1.1] Install xterm.js dependencies (`@xterm/xterm`, `@xterm/addon-fit`, `@xterm/addon-webgl`) [owner:engineer]

## 2. Component
- [ ] [2.1] Build XTerm React component with lifecycle management (mount/unmount cleanup) [owner:engineer]
- [ ] [2.2] Implement WebSocket connection to agent `/sessions/{id}/stream` endpoint [owner:engineer]
- [ ] [2.3] Add auto-fit on container resize (ResizeObserver + addon-fit) [owner:engineer]
- [ ] [2.4] Add WebGL renderer with fallback to canvas if WebGL unavailable [owner:engineer]

## 3. Connection Handling
- [ ] [3.1] Implement connection status indicator (green=connected, yellow=reconnecting, red=disconnected) [owner:engineer]
- [ ] [3.2] Handle reconnection on disconnect (3 retries, exponential backoff: 1s, 2s, 4s) [owner:engineer]

## 4. Validation
- [ ] [4.1] Write component tests: mount, render, cleanup [owner:engineer]
- [ ] [4.2] Write component test: connection status transitions [owner:engineer]
- [ ] [4.3] Write component test: auto-fit triggers on container resize [owner:engineer]
