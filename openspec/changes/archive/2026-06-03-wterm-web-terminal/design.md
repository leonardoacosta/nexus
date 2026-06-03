# Design: Web terminal via @wterm/ghostty

## Integration seam (from the vercel-labs/wterm audit)

```
agent /sessions/:id/stream (ws, Tailscale :7400)
  ├─ TEXT {"type":"geometry",cols,rows}  ──▶ core.resize(cols, rows)
  ├─ TEXT {"type":"replay_done"}          ──▶ mark live
  └─ BINARY  (raw PTY bytes)              ──▶ core.writeRaw(Uint8Array)   [@wterm/ghostty]
                                                         │
                                              @wterm/dom renderer (DOM spans)
                                                         │
  @wterm/dom onData(str)  ◀── keystrokes ──────────────┘
        │
        └─▶ /interact (ws):  BINARY stdin
  @wterm/dom onResize(cols,rows) ──▶ /interact TEXT {"type":"resize",cols,rows}
```

- **Renderer core:** `@wterm/ghostty` (libghostty 1.3.1 → WASM, Apache-2.0). Feed = `core.writeRaw(Uint8Array)`;
  grid = `core.resize(cols, rows)`; terminal replies (DSR/DA) via `core.getResponse()` routed back to `/interact`.
- **Renderer/input glue:** `@wterm/dom` provides the DOM renderer, the input keymap (app-cursor keys,
  bracketed paste, Ctrl-combos) emitting via `onData`, and a built-in `ResizeObserver` emitting `onResize`.
- **DO NOT** use wterm's `WebSocketTransport`. The agent protocol carries geometry JSON, `replay_done`,
  reconnect-replay, and the 4009 read-only close — richer than wterm's passthrough. The browser client
  implements the agent protocol directly, mirroring Swift `consumePtyStream` / `sendInteractiveInput` /
  `requestResize` (`apps/agent/src/server-websocket.ts`, `terminal/stream-manager.ts`).

## Key facts that de-risk this

- **No COOP/COEP / SharedArrayBuffer.** WASM loads via plain `fetch` + `WebAssembly.instantiate`,
  single-threaded. The committed `ghostty-vt.wasm` ships in the npm package — consumers need no Zig.
- **Byte-feed is the documented primary API**, not a hack.
- **VT-engine parity with iOS geistty** (same libghostty) — identical grid/parse; render backends differ.

## The one real unknown (GATE)

`@wterm/dom` renders **DOM spans, not Canvas/WebGL/Metal**. Under high-volume output (full-screen
redraws, fast scroll) this may not keep up the way xterm.js's GPU renderer does. This is a
**performance** question, not a viability one — settle it with an in-browser spike streaming a busy
session through `core.writeRaw` and measuring frame timing. Fallback if it fails: xterm.js +
`@xterm/addon-attach` (loses the iOS VT-engine parity that motivated @wterm/ghostty).

## Scope boundary

This feature delivers the `apps/web` skeleton + one fully-interactive attach route. Session list,
health, projects, and multi-agent aggregation are deferred to later features under the
`web-dashboard` capability. Single target agent via `NEXT_PUBLIC_NEXUS_AGENT_URL`; ws (no TLS) over
Tailscale.
