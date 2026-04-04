# Add XTerm Widget

## Why
The dashboard session detail page currently shows a placeholder where the terminal should be. Users need a real terminal emulator in the browser to view streaming session output (AC-4) and preserve scroll-back history (AC-5). xterm.js is the standard browser terminal emulator and renders ANSI escape sequences correctly (REQ-INTERACT-4).

## What Changes
Add a React component wrapping xterm.js with WebGL rendering, auto-fit to container, and WebSocket connection to the agent's stream endpoint. The component handles connection lifecycle including a status indicator (connected/reconnecting/disconnected) and automatic reconnection with exponential backoff. Dependencies: `@xterm/xterm`, `@xterm/addon-fit`, `@xterm/addon-webgl`.
