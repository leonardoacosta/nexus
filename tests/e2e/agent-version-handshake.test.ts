/**
 * E2E [4.1] (nx-gv2wm) + [4.2] (nx-xf639): agent version handshake → dashboard.
 *
 * Pins the user-facing contract that replaces the legacy "Agent unreachable"
 * banner with a per-failure-mode diagnostic. Two scenarios exercised end-to-end
 * through the real server-action pipeline + real SSR of `NotificationsClient`:
 *
 *   [4.1] Healthy agent: `/notifications` page renders the table and the body
 *         does NOT contain the literal string "Agent unreachable".
 *
 *   [4.2] Stale binary: `/version` advertises `GET /credentials` and
 *         `PATCH /notifications/settings` but omits `GET /notifications/settings`.
 *         `probeAgent()` classifies as `stale-binary`, the banner copy contains
 *         BOTH the build SHA and the missing capability name, and the controls
 *         render with `disabled` since `agentReachable === false`.
 *
 * Why bun:test + Bun.serve (not Playwright):
 *   The same trade-off `tests/e2e/README.md` documents — these regressions are
 *   data-flow + rendering contracts (server action → reachability → banner
 *   copy + control disablement). A real browser adds infra for no extra signal.
 *   The repo already uses this pattern in `credentials-accounts.test.ts` and
 *   `dashboard-offline.test.ts`; this test extends it to the version handshake.
 *
 * Strategy (mirrors `credentials-accounts.test.ts`):
 *   1. Boot a `Bun.serve` mock agent on a random port.
 *   2. `mock.module()` `@/lib/get-client` so `getAgentBaseUrl()` resolves to
 *      our fixture port — this is the seam the dashboard uses to find an agent.
 *   3. Per-test, swap the mock agent's `/version` response (full vs stale).
 *   4. Invoke the real `fetchNotificationsPageData()` server action and render
 *      `<NotificationsClient>` via `renderToString` (React 19 SSR — same path
 *      Next.js uses server-side).
 *   5. Assert on the rendered HTML: banner copy + control `disabled` attrs.
 *
 * Skip conditions: skipped (not failed) when `POSTGRES_URL` is missing or the
 * test DB is unreachable. The action also reads recent notifications from
 * Postgres (`fetchRecentNotifications`); missing DB ⇒ skip rather than spam
 * connection errors. We use the same `nexus_test` sentinel as the offline test.
 */

import {
  describe,
  test,
  expect,
  beforeAll,
  afterAll,
  beforeEach,
  mock,
} from "bun:test";

// ── Skip-if-missing preflight ──────────────────────────────────────────────
//
// Same sentinel as `dashboard-offline.test.ts`: only run against the test DB
// (whose name is `nexus_test`). Any other URL is treated as dev/prod and the
// suite is skipped to avoid clobbering live data.

const POSTGRES_URL = process.env.POSTGRES_URL;
const IS_TEST_DB = !!POSTGRES_URL && /\/nexus_test(?:[?#]|$)/.test(POSTGRES_URL);

if (!IS_TEST_DB) {
  const reason = POSTGRES_URL
    ? "POSTGRES_URL does not point at the nexus_test database"
    : "POSTGRES_URL not set";
  describe.skip(
    `E2E [4.1+4.2]: agent version handshake → dashboard banner (skipped — ${reason})`,
    () => {
      test("skipped", () => {
        /* no-op — visible in runner as skipped suite */
      });
    },
  );
} else {
  // ── Live-mock path ─────────────────────────────────────────────────────────

  // ─── Mock the agent-registry lookup so the real action hits our fixture ──
  //
  // `get-client.ts` exports `getAgentConfigs()` which `getAgentBaseUrl()`
  // consults to find the first enabled agent. We register the mock under BOTH
  // import specifiers (relative + alias) for the same reason
  // `credentials-accounts.test.ts` does — bun's runner doesn't apply tsconfig
  // path aliases, so the action's `@/lib/get-client` import resolves
  // differently from this test's relative import.
  const FIXTURE_PORT = { value: 0 };

  const mockGetClient = () => ({
    getAgentConfigs: async () => [
      { name: "fixture", host: "127.0.0.1", port: FIXTURE_PORT.value },
    ],
    getClient: async () => ({} as unknown),
    getAgentHost: async () => null,
  });

  mock.module("../../apps/nextjs/src/lib/get-client", mockGetClient);
  mock.module("@/lib/get-client", mockGetClient);

  // ─── Per-test stub knob for the mock /version response ────────────────────
  //
  // Each test mutates `versionResponse.value` before calling the action. The
  // mock server reads from the same object on every request so tests don't
  // need to spin up / tear down the server per-test (Bun.serve start cost is
  // small but non-zero and the random-port assignment would invalidate the
  // module mock above).
  type VersionPayload = {
    buildSha: string;
    builtAt: string;
    capabilities: string[];
  };

  const FULL_CAPABILITIES: VersionPayload = {
    buildSha: "f00ba12",
    builtAt: "2026-04-26T22:30:00Z",
    capabilities: [
      "GET /credentials",
      "GET /notifications/settings",
      "PATCH /notifications/settings",
    ],
  };

  const STALE_BINARY: VersionPayload = {
    buildSha: "deadbee",
    builtAt: "2026-04-25T22:30:00Z",
    capabilities: [
      "GET /credentials",
      // INTENTIONALLY MISSING: "GET /notifications/settings"
      "PATCH /notifications/settings",
    ],
  };

  const versionResponse: { value: VersionPayload } = {
    value: FULL_CAPABILITIES,
  };

  // ─── Mock agent server ──────────────────────────────────────────────────────

  let server: ReturnType<typeof Bun.serve> | null = null;

  beforeAll(() => {
    server = Bun.serve({
      port: 0,
      fetch(req) {
        const url = new URL(req.url);

        // The version handshake — auth-exempt by spec, so we don't check headers.
        if (url.pathname === "/version" && req.method === "GET") {
          return new Response(JSON.stringify(versionResponse.value), {
            headers: { "Content-Type": "application/json" },
          });
        }

        // GET /notifications/settings — only relevant when the version probe
        // returns ok:true and `fetchNotificationSettings()` runs. Returns a
        // canonical wire shape so the rendered `NotificationsClient` shows
        // controls in the enabled state for [4.1].
        if (
          url.pathname === "/notifications/settings" &&
          req.method === "GET"
        ) {
          return new Response(
            JSON.stringify({
              id: 1,
              tts_enabled: true,
              banner_enabled: true,
              ducking_mode: "full",
              updated_at: "2026-04-26T22:30:00Z",
            }),
            { headers: { "Content-Type": "application/json" } },
          );
        }

        return new Response("not found", { status: 404 });
      },
    });
    FIXTURE_PORT.value = server.port;
  });

  afterAll(() => {
    try {
      server?.stop(true);
    } catch {
      // best-effort
    }
  });

  beforeEach(() => {
    // Default to the healthy fixture; [4.2] flips this to STALE_BINARY.
    versionResponse.value = FULL_CAPABILITIES;
  });

  // Import AFTER module mocks so the action binds to the mocked module.
  const { fetchNotificationsPageData } = await import(
    "../../apps/nextjs/src/app/actions/notifications"
  );

  // React 19 server rendering — same path Next.js uses server-side. We render
  // the client component directly (it's `"use client"` but `renderToString`
  // happily produces its initial HTML, which is what the user first sees and
  // what the banner-copy + disabled-attribute assertions need).
  const { renderToString } = await import("react-dom/server");
  const React = await import("react");
  const { NotificationsClient } = await import(
    "../../apps/nextjs/src/app/notifications/NotificationsClient"
  );

  // ─── Tests ──────────────────────────────────────────────────────────────────

  describe("E2E [4.1+4.2]: agent version handshake → dashboard banner", () => {
    // ──────────────────────────────────────────────────────────────────────────
    // [4.1] Healthy agent → no "Agent unreachable" copy, table renders.
    // ──────────────────────────────────────────────────────────────────────────
    test("[4.1] healthy agent: notifications page renders without 'Agent unreachable' banner", async () => {
      versionResponse.value = FULL_CAPABILITIES;

      const data = await fetchNotificationsPageData();

      // Sanity: probe classified as ok and the boolean derived correctly.
      expect(data.reachability.ok).toBe(true);
      expect(data.agentReachable).toBe(true);
      // Settings row was fetched (proves the action progressed past the probe).
      expect(data.settings).not.toBeNull();
      expect(data.settings?.tts_enabled).toBe(true);

      const html = renderToString(
        React.createElement(NotificationsClient, {
          initialSettings: data.settings,
          initialRows: data.rows,
          agentReachable: data.agentReachable,
          reachability: data.reachability,
        }),
      );

      // The legacy banner string is BANNED across the codebase post-handshake.
      expect(html).not.toContain("Agent unreachable");

      // Banner element is hidden entirely when `agentReachable === true`
      // (see the `{!agentReachable && (...)}` guard in NotificationsClient).
      expect(html).not.toContain('data-testid="agent-banner"');

      // Controls render in the enabled state — the `disabled=""` attribute
      // appears in HTML only when React renders `disabled={true}`. With
      // settings present and not pending, all three controls should be
      // enabled. We assert the negative: no disabled TTS / banner toggles.
      // (We can't assert "no `disabled`" globally because `replay-button`
      // for some statuses might disable; but with no rows there are no
      // replay buttons rendered.)
      const ttsToggleTag = extractOpenTagByTestId(html, "toggle-tts");
      expect(ttsToggleTag).not.toContain("disabled");
      const bannerToggleTag = extractOpenTagByTestId(html, "toggle-banner");
      expect(bannerToggleTag).not.toContain("disabled");
    });

    // ──────────────────────────────────────────────────────────────────────────
    // [4.2] Stale binary → banner shows build SHA + missing capability,
    //       controls render with `disabled` attribute.
    // ──────────────────────────────────────────────────────────────────────────
    test("[4.2] stale binary: banner shows build SHA + missing capability, controls disabled", async () => {
      versionResponse.value = STALE_BINARY;

      const data = await fetchNotificationsPageData();

      // Sanity: classifier identified the stale binary (missing capability).
      expect(data.reachability.ok).toBe(false);
      expect(data.agentReachable).toBe(false);
      if (data.reachability.ok === false) {
        expect(data.reachability.reason).toBe("stale-binary");
        if (data.reachability.reason === "stale-binary") {
          expect(data.reachability.build.sha).toBe("deadbee");
          expect(data.reachability.missing).toContain(
            "GET /notifications/settings",
          );
        }
      }
      // The probe failed, so the action SHOULD have skipped the second hop
      // (`fetchNotificationSettings`) — settings is null in this branch.
      expect(data.settings).toBeNull();

      const html = renderToString(
        React.createElement(NotificationsClient, {
          initialSettings: data.settings,
          initialRows: data.rows,
          agentReachable: data.agentReachable,
          reachability: data.reachability,
        }),
      );

      // Banner element is now present (rendered because `!agentReachable`).
      expect(html).toContain('data-testid="agent-banner"');

      // Banner copy MUST contain the build SHA AND the missing capability.
      // The exact phrasing is owned by `bannerCopyForReachability` in
      // NotificationsClient.tsx; we assert the load-bearing substrings only,
      // not full punctuation, so a future copy edit doesn't break the test.
      // Use the full-element extractor (open tag + children + close tag) so
      // text content is in scope.
      const bannerHtml = extractFullElementByTestId(html, "agent-banner");
      expect(bannerHtml).toContain("deadbee");
      expect(bannerHtml).toContain("GET /notifications/settings");

      // The legacy generic banner copy is forbidden even in the failure path.
      expect(html).not.toContain("Agent unreachable");

      // Controls disabled: settings is null, which sets `settingsDisabled` and
      // propagates to the toggle/radio `disabled` attrs. SSR HTML emits the
      // attribute as `disabled=""` — presence in the OPENING tag is the
      // signal, so use the open-tag extractor (children of these buttons are
      // either nested spans or label text and don't carry `disabled`).
      const ttsToggleTag = extractOpenTagByTestId(html, "toggle-tts");
      expect(ttsToggleTag).toContain("disabled");
      const bannerToggleTag = extractOpenTagByTestId(html, "toggle-banner");
      expect(bannerToggleTag).toContain("disabled");
      const duckingFullTag = extractOpenTagByTestId(html, "ducking-full");
      expect(duckingFullTag).toContain("disabled");
    });
  });

  // ─── Helpers ───────────────────────────────────────────────────────────────

  /**
   * Slice out the opening tag for an element with the given `data-testid`.
   *
   * Returns the substring from `<` to the next `>` (so attribute assertions
   * like `disabled` / `data-testid` match against the element's own attrs and
   * not the surrounding markup). Falls back to the whole HTML when the testid
   * isn't found, so the assertion failure message is still informative.
   */
  function extractOpenTagByTestId(html: string, testId: string): string {
    const marker = `data-testid="${testId}"`;
    const at = html.indexOf(marker);
    if (at === -1) return html;
    const start = html.lastIndexOf("<", at);
    const end = html.indexOf(">", at);
    if (start === -1 || end === -1) return html;
    return html.slice(start, end + 1);
  }

  /**
   * Slice out the full element (opening tag + children + closing tag) for an
   * element with the given `data-testid`. Used when the assertion needs the
   * element's text content (e.g. banner copy).
   *
   * Naive but sufficient for the elements we target: `agent-banner` is a
   * `<span>` with no nested same-tag children. We find the opening `<TAG`,
   * derive the tag name, and scan forward to the matching `</TAG>`.
   */
  function extractFullElementByTestId(html: string, testId: string): string {
    const marker = `data-testid="${testId}"`;
    const at = html.indexOf(marker);
    if (at === -1) return html;
    const start = html.lastIndexOf("<", at);
    if (start === -1) return html;
    // Tag name lives between `<` and the first whitespace / `>`.
    const tagMatch = /^<([A-Za-z][A-Za-z0-9]*)/.exec(html.slice(start));
    if (!tagMatch) return html;
    const tagName = tagMatch[1]!;
    const close = `</${tagName}>`;
    const closeAt = html.indexOf(close, at);
    if (closeAt === -1) return html.slice(start);
    return html.slice(start, closeAt + close.length);
  }
}
