import { defineConfig, devices } from "@playwright/test";

/**
 * Playwright config for the web-terminal journey suite (wterm-web-terminal
 * Batch 4). Lives under `tests/e2e/playwright/` per the `tests/e2e/README.md`
 * forward-looking note ("When real Playwright coverage is needed ... a new
 * `tests/e2e/playwright/` subdirectory can be added alongside these bun
 * tests"). The bun integration tests in the parent dir are NOT collected by
 * Playwright (testDir is scoped to this folder, testMatch to *.spec.ts).
 *
 * Stack under test (all REAL — no mocks, per t3-testing-patterns):
 *   - Next.js web app (apps/web) on :7402, launched via `webServer` with
 *     NEXT_PUBLIC_NEXUS_AGENT_URL inlined so the browser clients hit the agent.
 *   - The already-running Nexus agent on NEXUS_AGENT_URL (default :7400),
 *     serving GET /sessions, POST /session/start, and the WS attach spine.
 *   - Real Postgres (POSTGRES_URL) + real tmux panes, wired by the harness.
 */

const WEB_PORT = Number(process.env.NEXUS_WEB_PORT ?? 7402);

/**
 * The Nexus agent enforces a Tailscale-origin CORS allowlist
 * (`apps/agent/src/server-origin.ts`): browser requests are only honoured when
 * the `Origin` is a `100.x.x.x` host, and CORS headers are ONLY attached for
 * such origins. A `localhost`-served page therefore gets a 403 + "Failed to
 * fetch" in the browser. To exercise the real journey we MUST serve the web app
 * on the machine's Tailscale IP and point both the page and the agent URL at
 * it, so the browser's fetch carries a `100.x` Origin the agent accepts.
 */
const TS_HOST = process.env.NEXUS_TS_HOST ?? "100.73.182.4";
const AGENT_URL =
  process.env.NEXUS_AGENT_URL?.replace(/\/+$/, "") ?? `http://${TS_HOST}:7400`;
const WEB_ORIGIN = `http://${TS_HOST}:${WEB_PORT}`;

export default defineConfig({
  testDir: ".",
  testMatch: "**/*.spec.ts",
  // Throughput gate (4.2) streams megabytes; give specs room but keep a ceiling.
  timeout: 120_000,
  expect: { timeout: 10_000 },
  // The 4.3 read-only test needs the writer mutex held by a *separate* browser
  // context within one spec; specs themselves run serially to avoid two
  // suites racing the single agent + shared tmux server.
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [["list"]],
  use: {
    baseURL: WEB_ORIGIN,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"] } },
    // Phone profile for the nx-2pekj phone-terminal journey: an iPhone-13-shaped
    // viewport (390x844, DPR 3) with touch + mobile emulation, so the
    // soft-keyboard bridge, pinch-zoom/pan, and the reflow button are exercised
    // under the conditions they target. We layer that profile onto CHROMIUM
    // (not the WebKit `devices["iPhone 13"]` default) because this CI host lacks
    // the system libs WebKit needs (libicu74/libxml2/libflite1, no sudo) — the
    // touch + viewport emulation is what the journey actually depends on, and
    // Chromium provides both.
    {
      name: "mobile-chrome",
      use: {
        ...devices["Desktop Chrome"],
        viewport: { width: 390, height: 844 },
        deviceScaleFactor: 3,
        isMobile: true,
        hasTouch: true,
      },
    },
  ],
  webServer: {
    // Production server, NOT `next dev`. In dev mode the Turbopack HMR
    // WebSocket (ws://<ts-ip>:PORT/_next/webpack-hmr) fails its handshake when
    // the page is served on the Tailscale IP, which in Next 16 wedges client
    // hydration so `"use client"` effects (the SessionList poll) never run and
    // the list is stuck on its loading skeleton. `next start` serves a built
    // bundle with no HMR, so hydration + the poll work normally. The build
    // MUST inline the SAME agent URL (NEXT_PUBLIC_* is build-time):
    //   NEXT_PUBLIC_NEXUS_AGENT_URL=http://<ts-ip>:7400 pnpm --filter @nexus/web build
    command: "pnpm --filter @nexus/web start",
    cwd: "../../..",
    url: WEB_ORIGIN,
    timeout: 120_000,
    reuseExistingServer: !process.env.CI,
    env: {
      NEXT_PUBLIC_NEXUS_AGENT_URL: AGENT_URL,
      NEXUS_WEB_PORT: String(WEB_PORT),
    },
  },
});
