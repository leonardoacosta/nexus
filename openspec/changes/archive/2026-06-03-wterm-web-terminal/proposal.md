# Change: Web terminal — interactive session attach in a new Next.js app via @wterm/ghostty

## Why

Nexus's dashboards are Swift-only (`nexus-mac`, `nexus-ios`, `nexus-watch`). There is **no web
client** — `apps/nextjs` is an empty build-artifact ghost dir, and the WS attach client
(`consumePtyStream`) exists only in Swift `NexusShared`. To attach to a session from a browser, we
need a real web surface and a browser-side client speaking the agent's WS protocol.

The agent already exposes the full attach spine over Tailscale on `:7400`:
`GET /sessions/:id/stream` (read) and `GET /sessions/:id/interact` (read+write), emitting raw binary
PTY bytes plus JSON control frames (`geometry`, `replay_done`). All that's missing is a browser
client + renderer.

The `vercel-labs/wterm` audit settled the renderer: **`@wterm/ghostty`** is real **libghostty 1.3.1
compiled to WASM** (Apache-2.0, npm), with a first-class external byte-feed API `core.writeRaw(Uint8Array)`
decoupled from any transport — and crucially it needs **no SharedArrayBuffer / COOP-COEP headers**
(plain `fetch` + `WebAssembly.instantiate`). Pairing it with `@wterm/dom` (renderer + input keymap +
`ResizeObserver`) gives a browser terminal driven directly by the agent's byte stream. Using
libghostty here also matches the iOS geistty direction, so web and iOS share the **same VT engine**
(identical grid/parse behavior — no cross-platform VT drift; render backends still differ, DOM spans
on web vs Metal on iOS).

## What Changes

This is the **first slice** of a new long-lived `web-dashboard` capability: a working **interactive
attach terminal**. Broader web-dashboard surfaces (session list, health, projects, multi-agent
aggregation) are explicitly out of scope and become later features under the same capability.

- **ADD** `apps/web` — a Next.js (App Router) app in the pnpm/turbo workspace, dev server
  Tailscale-bindable, pointed at a single target agent via `NEXT_PUBLIC_NEXUS_AGENT_URL`.
- **ADD** a browser agent WS client (TS): connects `/sessions/:id/stream` + `/sessions/:id/interact`,
  demuxes binary PTY bytes vs JSON control frames (`geometry`, `replay_done`), rewrites
  `http->ws`/`https->wss`, handles reconnect (`{type:"reconnect"}`) and the read-only writer-mutex
  close (code 4009).
- **ADD** a React attach view integrating `@wterm/ghostty` (`writeRaw`) + `@wterm/dom` (renderer,
  input keymap, `ResizeObserver`); WASM served by Next.js and loaded via `fetch` + `instantiate`.
- **ADD** full interactivity: stream `.bytes` -> `core.writeRaw`; `geometry` -> `core.resize`;
  wterm `onData` -> interact stdin; `onResize` -> `{type:"resize",cols,rows}`; input gated when
  read-only.
- **GATE**: a renderer-throughput spike — wterm's DOM renderer (not GPU) must sustain busy tmux
  output within an acceptable frame budget; record the verdict vs an xterm.js fallback threshold.

## Impact

- **Affected specs:** NEW `web-dashboard` (first proposal: interactive attach terminal).
- **Affected code (all new except workspace registration):**
  - NEW `apps/web/**` (Next.js app, browser WS client, attach view)
  - `pnpm-workspace.yaml`, `turbo.json` (register the new app)
- **Reuse, not rebuild:** `@wterm/ghostty` + `@wterm/dom` (depend), `examples/nextjs` from wterm as
  scaffold reference. **Do NOT** vendor wterm's `WebSocketTransport` — the agent protocol (binary +
  geometry JSON + 4009 read-only + reconnect-replay) is richer; the browser client implements that
  directly, mirroring Swift `consumePtyStream`.
- **Transport:** ws over Tailscale, no TLS (agent is tailnet-only). Single-agent attach; multi-agent
  aggregation is a future feature.
- **Out of scope:** full web dashboard (session list / health / projects pages), multi-agent
  aggregate client, auth beyond Tailscale, a TS port of the entire Swift `NexusClient`.
- **Open risk (the GATE):** DOM-renderer throughput under high-volume output. If it fails the budget,
  the fallback is xterm.js (loses iOS VT parity) — flagged, not pre-decided.

## Context
- touches: `apps/web/package.json`, `apps/web/src/app/attach/[session]/page.tsx`, `apps/web/src/lib/agent-ws-client.ts`, `pnpm-workspace.yaml`, `turbo.json`
