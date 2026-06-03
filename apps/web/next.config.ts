import type { NextConfig } from "next";

/**
 * Nexus web dashboard — Next.js config.
 *
 * WASM serving (task 1.2): the committed `ghostty-vt.wasm` (from @wterm/ghostty)
 * is copied into `public/ghostty-vt.wasm` so the browser can load it via a
 * stable, MIME-correct URL (`/ghostty-vt.wasm`). Next.js serves files under
 * `public/` with `Content-Type: application/wasm` out of the box (it infers
 * the MIME from the extension), and `fetch()` + `WebAssembly.instantiate()`
 * accept that content type directly.
 *
 * CROSS-ORIGIN ISOLATION: we deliberately set NO COOP/COEP headers. libghostty
 * 1.3.x compiled to WASM is single-threaded and never touches SharedArrayBuffer
 * (verified: @wterm/ghostty's loader uses only a plain `fetch` + single-arg
 * `WebAssembly.instantiate(bytes, { env: { log } })` — no threads, no SAB), so
 * cross-origin isolation is NOT required. Adding COOP/COEP would only risk
 * breaking other embeds for zero benefit.
 */
const nextConfig: NextConfig = {
  // The agent is tailnet-only ws (no TLS); the web app talks to it purely from
  // the browser via NEXT_PUBLIC_NEXUS_AGENT_URL, so there is no server-side
  // rewrite/proxy here — keep the surface minimal.
  async headers() {
    return [
      {
        // Ensure the WASM asset advertises the correct MIME type explicitly
        // (defense-in-depth; Next already infers it from the .wasm extension).
        source: "/ghostty-vt.wasm",
        headers: [{ key: "Content-Type", value: "application/wasm" }],
      },
    ];
  },
};

export default nextConfig;
