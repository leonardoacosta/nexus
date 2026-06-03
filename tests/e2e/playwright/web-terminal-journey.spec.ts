/**
 * [4.1] Web-terminal journey: spin up -> close page -> return -> see -> type ->
 * live I/O, end to end against the REAL agent + REAL tmux pane + REAL Postgres.
 *
 * The session is a controlled `bash --noprofile --norc` tmux window (harness),
 * so its output is deterministic — we own every byte the pane emits. The agent
 * lazy-attaches a `TmuxPtySource` on first WS connect and forwards pane output
 * (pipe-pane) and stdin (send-keys), exactly as it does for a real `claude`
 * window, but without the nondeterminism of a live model.
 */
import { test, expect } from "@playwright/test";
import {
  AGENT_URL,
  assertAgentUp,
  createControlledSession,
  destroyControlledSession,
  type ControlledSession,
} from "./harness/session-harness";

let sess: ControlledSession;

test.beforeAll(async () => {
  await assertAgentUp();
  sess = createControlledSession("journey");
});

test.afterAll(() => {
  if (sess) destroyControlledSession(sess);
});

const attachHref = () => `/attach/${encodeURIComponent(sess.sessionId)}`;

/** The wterm renderer puts pane text into .term-grid > .term-row > span. */
const gridText = async (page: import("@playwright/test").Page) =>
  (await page.locator(".term-grid").first().textContent()) ?? "";

test("full journey: list -> attach -> render -> type -> live I/O -> persists", async ({
  page,
}) => {
  await test.step("home lists at least one active session (incl. ours)", async () => {
    await page.goto("/");
    // The poll has a 3s interval and the agent list cache is 1s TTL; our row
    // surfaces within a couple polls. The attach link carries the session id.
    const ourLink = page.locator(`a[href="${attachHref()}"]`);
    await expect(ourLink).toBeVisible({ timeout: 20_000 });
    // At least one session is listed (sanity: the "no active sessions" empty
    // notice is NOT shown).
    await expect(
      page.getByText("No active sessions", { exact: false }),
    ).toHaveCount(0);
  });

  await test.step("navigate to /attach/:id and connect (status -> Live)", async () => {
    await page.goto(attachHref());
    // The grid mounts once WASM loads...
    await expect(page.locator(".term-grid").first()).toBeVisible({
      timeout: 30_000,
    });
    // ...and the status pill must reach "Live" — this is the signal that BOTH
    // the stream (read) channel is open AND the interact (write) channel
    // claimed the writer mutex. Typing before this races the interact WS open
    // and the keystrokes are silently dropped (no socket to send on).
    await expect(page.getByText("Live", { exact: true })).toBeVisible({
      timeout: 30_000,
    });
  });

  await test.step("(c) terminal bytes RENDER — the bash prompt appears in the DOM", async () => {
    // Render proof independent of any input: the controlled pane runs
    // `bash --noprofile --norc`, whose default prompt is `bash-N.N$`. On attach
    // the agent forwards the pane's scrollback (pipe-pane) over the stream WS
    // and the wterm renderer paints it into .term-grid. Seeing the prompt text
    // in the DOM proves the read leg (PTY bytes -> render) works end to end.
    await expect
      .poll(async () => await gridText(page), {
        timeout: 30_000,
        message: "bash prompt never rendered — read leg (bytes -> DOM) broken",
      })
      .toMatch(/bash-\d/);
  });

  const marker = `nexus-e2e-${Math.floor(Math.random() * 1e9)}`;

  await test.step("(d) type a command, assert echoed output appears (live round-trip)", async () => {
    // Focus the terminal host and type. WTerm.onData -> interact WS -> agent
    // send-keys -> tmux pane -> pipe-pane -> stream WS -> renderer.
    //
    // `{ delay }` paces keystrokes: the agent's TmuxPtySource.write forwards
    // each stdin frame with a fire-and-forget `tmux send-keys -l`, so a 0-delay
    // burst races the subprocesses and scrambles char order (a real agent bug,
    // reported separately — apps/agent/src/terminal/tmux-pty-source.ts). A
    // realistic human typing cadence both avoids the race and is the honest
    // user action.
    // WTerm renders a hidden <textarea> (aria-hidden) as its keyboard target.
    // Focus it deterministically rather than relying on a grid click landing on
    // it — keystrokes only flow once that textarea has focus.
    const input = page.locator(".wterm textarea, .term-grid textarea").first();
    await expect(input).toBeAttached({ timeout: 10_000 });
    await input.focus();
    await page.keyboard.type(`echo ${marker}`, { delay: 75 });
    await page.keyboard.press("Enter");

    // The echoed command line AND its output line both contain the marker.
    // Wait for the rendered grid to contain it (proves full duplex I/O).
    await expect
      .poll(async () => await gridText(page), {
        timeout: 30_000,
        message: "typed marker never rendered — round-trip broken",
      })
      .toContain(marker);
  });

  await test.step("close the page, return home, session still listed + re-attachable (persistence)", async () => {
    // Simulate "close the page and come back": navigate away to home.
    await page.goto("/");
    const ourLink = page.locator(`a[href="${attachHref()}"]`);
    await expect(ourLink).toBeVisible({ timeout: 20_000 });

    // Re-attach: the same session id, still backed by the same tmux pane.
    await ourLink.click();
    await expect(page).toHaveURL(new RegExp(`/attach/`));
    await expect(page.locator(".term-grid").first()).toBeVisible({
      timeout: 30_000,
    });

    // On reconnect the agent replays its ring buffer — the earlier marker we
    // typed should still be visible in the replayed scrollback, proving the
    // session survived the page close with state intact.
    await expect
      .poll(async () => await gridText(page), {
        timeout: 30_000,
        message: "replayed scrollback missing the earlier marker",
      })
      .toContain(marker);
  });
});

test("agent base URL is wired into the browser bundle", async ({ page }) => {
  // Guards the harness contract: NEXT_PUBLIC_NEXUS_AGENT_URL must be inlined,
  // else the home page renders the "agent not configured" message and every
  // other test is silently meaningless.
  await page.goto("/");
  await expect(
    page.getByText("agent not configured", { exact: false }),
  ).toHaveCount(0);
  await expect(page.getByText(AGENT_URL, { exact: false })).toBeVisible({
    timeout: 10_000,
  });
});
