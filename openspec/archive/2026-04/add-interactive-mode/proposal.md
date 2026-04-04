# Add Interactive Mode

## Why
Stream-only viewing (Wave 4.3) lets users watch sessions but not control them. Ship criterion #3 and acceptance criteria AC-7/AC-8/AC-9 require full interactive terminal control from the dashboard, including keystroke forwarding, Ctrl+C handling, and browser resize propagation to the remote PTY.

## What Changes
Add an "Interact" button to the session detail page that upgrades the WebSocket connection from the read-only stream endpoint to the bidirectional interact endpoint. In interactive mode, all keyboard input is captured and forwarded as raw bytes, browser resize events are sent as JSON control frames, and a mode indicator distinguishes "Streaming (read-only)" from "Interactive". A disconnect button provides an escape hatch back to read-only mode.
