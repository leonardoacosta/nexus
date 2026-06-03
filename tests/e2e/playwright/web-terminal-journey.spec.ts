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
import { test, expect, type Page } from "@playwright/test";
import {
  AGENT_URL,
  assertAgentUp,
  createControlledSession,
  destroyControlledSession,
  tmuxSendKeys,
  type ControlledSession,
} from "./harness/session-harness";

/**
 * Stick-to-bottom proof (nx-2pekj regression guard). The `.wterm` host is the
 * scroll container. Returns whether the live bottom is within the visible
 * viewport — `scrollHeight - scrollTop - clientHeight` is small AND the grid
 * actually overflows (so the assertion is meaningful, not trivially true on a
 * short pane). Asserting text-in-DOM is NOT enough: the regression Leo hit had
 * the rows in the DOM but scrolled out of view (viewport parked at the empty
 * scrollback top).
 */
const viewportScrollState = (p: Page) =>
  p.evaluate(() => {
    const el = document.querySelector<HTMLElement>(".wterm");
    if (!el) return { overflows: false, distFromBottom: 0, atBottom: false };
    const distFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    const rowH =
      parseFloat(getComputedStyle(el).getPropertyValue("--term-row-height")) ||
      17;
    return {
      overflows: el.scrollHeight - el.clientHeight > rowH, // content > viewport
      distFromBottom,
      atBottom: distFromBottom <= rowH * 2,
    };
  });

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

  const tailMarker = `nexus-tail-${Math.floor(Math.random() * 1e9)}`;

  await test.step("(e) live content STAYS in the visible viewport — stick-to-bottom (nx-2pekj regression)", async () => {
    // Emit a screenful+ of output so the grid OVERFLOWS the viewport, then a
    // unique tail marker. The bug Leo hit: a fresh attach / new output parked
    // the viewport at the empty scrollback TOP, so the latest line was in the
    // DOM but invisible. We assert (1) the grid overflows (so the test is
    // meaningful), (2) the viewport is pinned at the bottom, and (3) the tail
    // marker is within the visible scroll band — not just present in the DOM.
    tmuxSendKeys(sess.tmuxTarget, `seq 1 200; echo ${tailMarker}`);

    // Wait for the tail marker to render at all.
    await expect
      .poll(async () => await gridText(page), {
        timeout: 30_000,
        message: "tail marker never rendered",
      })
      .toContain(tailMarker);

    // The viewport must have auto-scrolled to the live bottom.
    await expect
      .poll(async () => await viewportScrollState(page), {
        timeout: 10_000,
        message:
          "viewport did not stick to bottom — fresh output is scrolled out of view (the blank-terminal regression)",
      })
      .toMatchObject({ overflows: true, atBottom: true });

    // And the tail marker's row must lie within the visible viewport band, not
    // above the scrolled-out top. Geometric check on the rendered row.
    const tailVisible = await page.evaluate((m) => {
      const host = document.querySelector<HTMLElement>(".wterm");
      if (!host) return false;
      const rows = Array.from(host.querySelectorAll<HTMLElement>(".term-row"));
      const row = rows.find((r) => (r.textContent ?? "").includes(m));
      if (!row) return false;
      const hb = host.getBoundingClientRect();
      const rb = row.getBoundingClientRect();
      // Row's vertical center is inside the host's visible rect.
      const mid = rb.top + rb.height / 2;
      return mid >= hb.top && mid <= hb.bottom;
    }, tailMarker);
    expect(
      tailVisible,
      "tail marker row is rendered but NOT inside the visible viewport",
    ).toBe(true);
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

    // On reconnect the agent replays its ring buffer. We assert the MOST RECENT
    // tail marker (emitted last, step e) survives — it is guaranteed within the
    // replay window. The earlier `marker` was pushed out of the ring buffer by
    // the 200-line burst in step (e), which is expected ring-buffer rotation,
    // not a persistence failure.
    await expect
      .poll(async () => await gridText(page), {
        timeout: 30_000,
        message: "replayed scrollback missing the tail marker",
      })
      .toContain(tailMarker);

    // Re-attach must ALSO land at the live bottom (the regression also affected
    // reconnect, not just first attach).
    await expect
      .poll(async () => await viewportScrollState(page), {
        timeout: 10_000,
        message: "re-attach did not stick to bottom",
      })
      .toMatchObject({ atBottom: true });
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
