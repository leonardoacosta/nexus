/**
 * [nx-p9gk4] "Resize on close." When the web client closes/navigates away, it
 * must send a CLEAN WS close on BOTH channels so the agent's existing
 * clean-close restore path (server-websocket.ts close handler ->
 * maybeRestoreTakeover -> restoreGeometry/restoreWindowSize) resizes the shared
 * tmux pane back PROMPTLY — instead of the user (Leo's Mac / other viewers)
 * waiting out the ~40s pong timeout.
 *
 * The CLIENT-SIDE deliverable (what this repo owns) is: on `pagehide`, close
 * both the /stream and /interact sockets cleanly. We assert exactly that via
 * Playwright's native WebSocket observer (`page.on("websocket")`), which is
 * authoritative and needs no monkeypatching. The agent-side tmux restore that
 * consumes those closes lives in apps/agent (out of scope here) and is gated on
 * the last-viewer disconnect — it only re-fits when a real peer client (Leo's
 * terminal) is still attached, so it is verified separately against the live
 * deployment, not in this harness's zero-peer controlled session.
 *
 * Runs on the phone project for parity with the mobile lifecycle this targets.
 */
import { test, expect } from "@playwright/test";
import {
  assertAgentUp,
  createControlledSession,
  destroyControlledSession,
  type ControlledSession,
} from "./harness/session-harness";

let sess: ControlledSession;

test.beforeAll(async () => {
  await assertAgentUp();
  sess = createControlledSession("disc");
});
test.afterAll(() => {
  if (sess) destroyControlledSession(sess);
});

test("pagehide cleanly closes BOTH stream + interact sockets (resize-on-close)", async ({
  browser,
  viewport,
  hasTouch,
}) => {
  test.skip(!viewport || viewport.width > 500, "phone project only");

  const ctx = await browser.newContext({
    viewport: { width: 390, height: 844 },
    hasTouch: hasTouch ?? true,
    isMobile: true,
    deviceScaleFactor: 3,
  });
  const page = await ctx.newPage();

  // Observe socket lifecycle without monkeypatching the page.
  const sockets: { url: string; closed: boolean }[] = [];
  page.on("websocket", (ws) => {
    const rec = {
      url: ws.url().replace(/^.*\/sessions\//, ".../"),
      closed: false,
    };
    sockets.push(rec);
    ws.on("close", () => {
      rec.closed = true;
    });
  });

  await page.goto(`/attach/${encodeURIComponent(sess.sessionId)}`);
  await expect(page.locator(".term-grid").first()).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText("Live", { exact: true })).toBeVisible({
    timeout: 30_000,
  });
  await page.waitForTimeout(500);

  // Both channels must be open before we test the close.
  expect(sockets.length, "expected stream + interact sockets").toBeGreaterThanOrEqual(
    2,
  );
  expect(sockets.some((s) => s.url.endsWith("/stream"))).toBe(true);
  expect(sockets.some((s) => s.url.endsWith("/interact"))).toBe(true);

  // Fire the mobile-correct lifecycle signal. The `pagehide` listener in
  // TerminalAttach calls client.close(), which must clean-close BOTH sockets so
  // the agent's last-viewer restore path runs immediately (no 40s pong wait).
  await page.evaluate(() =>
    window.dispatchEvent(new PageTransitionEvent("pagehide")),
  );
  await page.waitForTimeout(800);

  for (const s of sockets) {
    expect(
      s.closed,
      `socket ${s.url} did NOT close on pagehide — agent would wait out the ~40s pong timeout before restoring the pane`,
    ).toBe(true);
  }

  await ctx.close();
});
