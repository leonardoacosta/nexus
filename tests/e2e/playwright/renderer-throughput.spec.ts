/**
 * [4.2] GATE — renderer throughput.
 *
 * Streams high-volume PTY output through the LIVE attach view (real agent ->
 * stream WS -> @wterm/ghostty core -> @wterm/dom renderer) and measures, IN THE
 * BROWSER, how long the renderer takes to drain it and whether the tab stays
 * responsive. The budget is a concrete pass/fail, recorded in the assertion +
 * console output. If it fails, the report records the xterm.js fallback
 * trade-off rather than silently passing.
 *
 * Method:
 *   - Drive a large burst from the pane side (`yes ... | head` produces ~2 MB
 *     of text on stdout). The agent's pipe-pane forwards it over the stream WS
 *     as binary frames; the wterm core parses + the renderer paints.
 *   - "Drained" = a unique END sentinel echoed AFTER the burst appears in the
 *     DOM grid. Time from "burst sent" to "sentinel visible" is the end-to-end
 *     render-drain latency for the payload.
 *   - Responsiveness = the page main thread still answers an `evaluate`
 *     round-trip with bounded latency WHILE/AFTER draining (a hung tab would
 *     blow past the budget or time out).
 *
 * BUDGET (stated up front, asserted below):
 *   - Drain ~2 MB end-to-end in < 25 s.
 *   - Main-thread ping after drain returns in < 1 s (tab not wedged).
 */
import { test, expect } from "@playwright/test";
import {
  assertAgentUp,
  createControlledSession,
  destroyControlledSession,
  tmuxSendKeys,
  type ControlledSession,
} from "./harness/session-harness";

const PAYLOAD_BYTES = 2_000_000;
const DRAIN_BUDGET_MS = 25_000;
const RESPONSIVE_BUDGET_MS = 1_000;

let sess: ControlledSession;

test.beforeAll(async () => {
  await assertAgentUp();
  sess = createControlledSession("throughput");
});

test.afterAll(() => {
  if (sess) destroyControlledSession(sess);
});

test("GATE: renderer drains ~2MB burst within budget without hanging the tab", async ({
  page,
}) => {
  const gridText = async () =>
    (await page.locator(".term-grid").first().textContent()) ?? "";

  await test.step("attach + reach Live", async () => {
    await page.goto(`/attach/${encodeURIComponent(sess.sessionId)}`);
    await expect(page.locator(".term-grid").first()).toBeVisible({
      timeout: 30_000,
    });
    await expect(page.getByText("Live", { exact: true })).toBeVisible({
      timeout: 30_000,
    });
    await expect
      .poll(gridText, { timeout: 30_000 })
      .toMatch(/bash-\d/);
  });

  const sentinel = `DRAIN-DONE-${Math.floor(Math.random() * 1e9)}`;
  let drainMs = -1;

  await test.step(`stream ${PAYLOAD_BYTES} bytes + measure drain`, async () => {
    // Drive the burst from the PANE side via tmux send-keys (server-side, so we
    // measure pure read-path throughput, not the input round-trip). `yes` emits
    // "y\n" forever; head caps the byte count; then we echo a sentinel that can
    // only render AFTER the whole burst has streamed + been parsed + painted.
    const t0 = Date.now();
    tmuxSendKeys(
      sess.tmuxTarget,
      `yes nexus-throughput-line | head -c ${PAYLOAD_BYTES}; echo; echo ${sentinel}`,
    );

    // Poll the grid for the sentinel. The grid is a windowed view (scrollback
    // ring), so the bulk of the 2 MB scrolls past; the sentinel landing proves
    // the renderer consumed the whole stream and stayed live to paint the tail.
    await expect
      .poll(gridText, {
        timeout: DRAIN_BUDGET_MS,
        intervals: [250, 500, 1000],
        message: `sentinel not drained within ${DRAIN_BUDGET_MS}ms — throughput GATE FAILED`,
      })
      .toContain(sentinel);
    drainMs = Date.now() - t0;
  });

  await test.step("tab stays responsive after the burst", async () => {
    // A hung renderer would block the main thread. Time a trivial main-thread
    // round-trip; it must answer quickly.
    const t0 = Date.now();
    const answer = await page.evaluate(() => 6 * 7);
    const pingMs = Date.now() - t0;
    expect(answer).toBe(42);
    // eslint-disable-next-line no-console
    console.log(
      `[THROUGHPUT GATE] payload=${PAYLOAD_BYTES}B drainMs=${drainMs} ` +
        `(budget ${DRAIN_BUDGET_MS}) mainThreadPingMs=${pingMs} ` +
        `(budget ${RESPONSIVE_BUDGET_MS}) -> ${
          drainMs >= 0 &&
          drainMs < DRAIN_BUDGET_MS &&
          pingMs < RESPONSIVE_BUDGET_MS
            ? "PASS"
            : "FAIL"
        }`,
    );
    expect(
      pingMs,
      "main thread wedged after burst — renderer cannot keep up",
    ).toBeLessThan(RESPONSIVE_BUDGET_MS);
  });

  expect(
    drainMs,
    `drain ${drainMs}ms exceeded ${DRAIN_BUDGET_MS}ms budget`,
  ).toBeLessThan(DRAIN_BUDGET_MS);
});
