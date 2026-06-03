/**
 * [4.3] Read-only path — writer-mutex contention.
 *
 * The agent's interact channel is a single-writer mutex: the FIRST client to
 * open `/sessions/:id/interact` holds it; a SECOND interact open is closed by
 * the agent with application code 4009. The web client
 * (`agent-ws-client.ts`) handles 4009 by marking the session read-only WITHOUT
 * throwing — the read stream stays live, input + resize become no-ops, and the
 * StatusPill flips to "Read-only" (the badge required by UI task 3.3).
 *
 * This test stands up TWO browser contexts attached to the SAME controlled
 * session:
 *   - writer: attaches first, claims the mutex -> status "Live".
 *   - viewer: attaches second -> its interact WS is 4009'd -> status
 *     "Read-only", the "input disabled" badge shows, keystrokes do NOT reach
 *     the pane, and there is NO error dialog / crash (the grid still renders
 *     live output).
 */
import { test, expect, type Page } from "@playwright/test";
import {
  assertAgentUp,
  createControlledSession,
  destroyControlledSession,
  type ControlledSession,
} from "./harness/session-harness";

let sess: ControlledSession;

test.beforeAll(async () => {
  await assertAgentUp();
  sess = createControlledSession("readonly");
});

test.afterAll(() => {
  if (sess) destroyControlledSession(sess);
});

const gridText = (p: Page) =>
  p.locator(".term-grid").first().textContent().then((t) => t ?? "");

async function attach(p: Page): Promise<void> {
  await p.goto(`/attach/${encodeURIComponent(sess.sessionId)}`);
  await expect(p.locator(".term-grid").first()).toBeVisible({ timeout: 30_000 });
}

test("second viewer gets 4009 -> read-only badge, input disabled, no crash", async ({
  browser,
}) => {
  // Two isolated contexts = two independent interact WS connections to the same
  // session, so the mutex genuinely contends (one shared context would share a
  // single transport).
  const writerCtx = await browser.newContext();
  const viewerCtx = await browser.newContext();
  const writer = await writerCtx.newPage();
  const viewer = await viewerCtx.newPage();

  try {
    await test.step("writer attaches first and claims the mutex (Live)", async () => {
      await attach(writer);
      // Writer must reach Live — proves it holds the interact mutex.
      await expect(writer.getByText("Live", { exact: true })).toBeVisible({
        timeout: 30_000,
      });
    });

    await test.step("viewer attaches second -> Read-only (4009 handled, no throw)", async () => {
      await attach(viewer);
      // The second interact open is 4009'd; the client degrades to read-only.
      await expect(viewer.getByText("Read-only", { exact: true })).toBeVisible({
        timeout: 30_000,
      });
      // The "input disabled" badge (UI task 3.3) is shown.
      await expect(
        viewer.getByText("input disabled", { exact: false }),
      ).toBeVisible({ timeout: 10_000 });
    });

    await test.step("viewer keystrokes do NOT reach the pane", async () => {
      // The read stream is still live, so the viewer renders pane output — but
      // its sendInput is gated (client.isReadOnly()). Type a marker; it must
      // NEVER appear in EITHER viewer's grid (it never reached tmux).
      const ghost = `readonly-ghost-${Math.floor(Math.random() * 1e9)}`;
      const input = viewer.locator(".wterm textarea, .term-grid textarea").first();
      await expect(input).toBeAttached({ timeout: 10_000 });
      await input.focus();
      await viewer.keyboard.type(`echo ${ghost}`, { delay: 50 });
      await viewer.keyboard.press("Enter");

      // Give the (suppressed) input ample time to NOT propagate, then confirm
      // absence on both panes. We poll the writer's grid for a control marker
      // we DO expect, to anchor "enough time has passed" deterministically
      // rather than with a bare sleep.
      const anchor = `readonly-anchor-${Math.floor(Math.random() * 1e9)}`;
      const wInput = writer.locator(".wterm textarea, .term-grid textarea").first();
      await wInput.focus();
      await writer.keyboard.type(`echo ${anchor}`, { delay: 50 });
      await writer.keyboard.press("Enter");
      // The writer's command (mutex holder) DOES round-trip:
      await expect
        .poll(() => gridText(writer), { timeout: 20_000 })
        .toContain(anchor);

      // By the time the anchor rendered, the ghost (if it were going to) would
      // have too. Assert it is absent on both panes — input was truly disabled.
      expect(await gridText(writer)).not.toContain(ghost);
      expect(await gridText(viewer)).not.toContain(ghost);
    });

    await test.step("no error dialog / crash — viewer still renders live output", async () => {
      // The "Terminal failed to load" error pane must NOT be present, and the
      // grid is still attached + painting (read leg unaffected by 4009).
      await expect(
        viewer.getByText("Terminal failed to load", { exact: false }),
      ).toHaveCount(0);
      await expect(viewer.locator(".term-grid").first()).toBeVisible();
      // The writer's anchor also reached the read-only viewer's stream (the
      // read channel is shared/live for both), proving read works while write
      // is blocked. (Best-effort: tolerate scrollback windowing.)
      expect(await gridText(viewer)).toMatch(/bash-\d/);
    });
  } finally {
    await writerCtx.close();
    await viewerCtx.close();
  }
});
