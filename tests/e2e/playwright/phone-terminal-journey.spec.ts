/**
 * [nx-2pekj] Phone-optimized terminal journey: prove the attach view is usable
 * ON A PHONE viewport (iPhone 13, 390x844, hasTouch) against the REAL agent +
 * REAL tmux pane + REAL Postgres — same controlled `bash --noprofile --norc`
 * session the desktop journey uses.
 *
 * Legs proven, each with a screenshot artifact under docs/screenshots/:
 *   (a) default fit-width scaled view renders readable + navigable
 *   (b) pinch-zoom + pan engages (synthetic two-finger Touch events)
 *   (c) landscape (rotated viewport) re-fits smoothly
 *   (d) typing a command round-trips via the soft-keyboard bridge (the WTerm
 *       hidden textarea + our beforeinput Enter/Backspace bridge)
 *   (e) opt-in "Fit to my screen" reflow resizes the shared pane once
 *
 * This project runs ONLY under the `mobile-chrome` Playwright project (touch +
 * iPhone-shaped viewport on Chromium). It does not regress the desktop specs
 * (the `chromium` project does not match the phone-viewport guard below).
 */
import { test, expect, type Page } from "@playwright/test";
import {
  assertAgentUp,
  createControlledSession,
  destroyControlledSession,
  type ControlledSession,
} from "./harness/session-harness";

// Resolve docs/screenshots from THIS spec file (ESM-safe — no __dirname). The
// spec lives at tests/e2e/playwright/, so the repo root is three dirs up.
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
const HERE = dirname(fileURLToPath(import.meta.url));
const SHOTS = join(HERE, "..", "..", "..", "docs", "screenshots");

let sess: ControlledSession;

test.beforeAll(async () => {
  await assertAgentUp();
  sess = createControlledSession("phone");
});

test.afterAll(() => {
  if (sess) destroyControlledSession(sess);
});

const attachHref = () => `/attach/${encodeURIComponent(sess.sessionId)}`;
const gridText = (p: Page) =>
  p.locator(".term-grid").first().textContent().then((t) => t ?? "");

/** Synthesize a two-finger pinch-out (zoom in) over the gesture surface. */
async function pinchOut(page: Page) {
  const surface = page.locator(".term-grid").first();
  const box = await surface.boundingBox();
  if (!box) throw new Error("no terminal surface to pinch");
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;
  // The gesture handlers live on the surface that WRAPS the transform layer;
  // dispatch the touch sequence on the element under the centroid.
  await page.evaluate(
    ({ cx, cy }) => {
      const target = document.elementFromPoint(cx, cy);
      if (!target) return;
      const mk = (
        type: string,
        touches: { id: number; x: number; y: number }[],
      ) => {
        const ts = touches.map(
          (t) =>
            new Touch({
              identifier: t.id,
              target: target as Element,
              clientX: t.x,
              clientY: t.y,
            }),
        );
        target.dispatchEvent(
          new TouchEvent(type, {
            bubbles: true,
            cancelable: true,
            touches: ts,
            targetTouches: ts,
            changedTouches: ts,
          }),
        );
      };
      // Start fingers close, move them apart (pinch-out => zoom in).
      mk("touchstart", [
        { id: 0, x: cx - 20, y: cy },
        { id: 1, x: cx + 20, y: cy },
      ]);
      for (let i = 1; i <= 6; i++) {
        const spread = 20 + i * 22;
        mk("touchmove", [
          { id: 0, x: cx - spread, y: cy },
          { id: 1, x: cx + spread, y: cy },
        ]);
      }
      mk("touchend", []);
    },
    { cx, cy },
  );
}

test("phone journey: scaled view + zoom + landscape + type + reflow", async ({
  page,
  viewport,
  hasTouch,
}) => {
  // Phone-only: skip under the desktop `chromium` project (so a full-suite run
  // never regresses desktop). The `mobile-chrome` project sets a 390px touch
  // viewport. Assert touch is on so a misconfigured project fails loud.
  test.skip(
    !viewport || viewport.width > 500,
    "phone journey runs on the mobile-chrome (390px viewport) project only",
  );
  expect(hasTouch, "mobile-chrome project must enable hasTouch").toBe(true);

  await test.step("home list is touch-usable at phone width", async () => {
    await page.goto("/");
    const ourLink = page.locator(`a[href="${attachHref()}"]`);
    await expect(ourLink).toBeVisible({ timeout: 20_000 });
    await page.screenshot({ path: `${SHOTS}/phone-session-list.png` });
  });

  await test.step("attach + connect (status -> Live)", async () => {
    await page.goto(attachHref());
    await expect(page.locator(".term-grid").first()).toBeVisible({
      timeout: 30_000,
    });
    await expect(page.getByText("Live", { exact: true })).toBeVisible({
      timeout: 30_000,
    });
    // Read leg: the bash prompt paints.
    await expect
      .poll(() => gridText(page), { timeout: 30_000 })
      .toMatch(/bash-\d/);
  });

  await test.step("(a) default fit-width scaled view — readable + controls present", async () => {
    // The fit math sets --term-font-size; assert it is within the legibility
    // band (floor 6px .. base 14px) so the pane is scaled-to-fit, not garbled.
    const fontPx = await page.evaluate(() => {
      const el = document.querySelector<HTMLElement>(".wterm");
      return el
        ? parseFloat(getComputedStyle(el).getPropertyValue("--term-font-size"))
        : 0;
    });
    expect(fontPx).toBeGreaterThanOrEqual(6);
    expect(fontPx).toBeLessThanOrEqual(14);
    // The phone control bar is present and tappable.
    await expect(
      page.getByRole("button", { name: "Fit width" }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Fit to my screen" }),
    ).toBeVisible();
    await page.screenshot({ path: `${SHOTS}/phone-default-scaled.png` });
  });

  await test.step("(b) pinch-zoom + pan engages (transform scale > 1)", async () => {
    await pinchOut(page);
    // The transform layer is the immediate parent of the .wterm host; its
    // matrix scale must exceed 1 after the pinch.
    const scale = await page.evaluate(() => {
      const host = document.querySelector<HTMLElement>(".wterm");
      const layer = host?.parentElement;
      if (!layer) return 1;
      const m = new DOMMatrixReadOnly(getComputedStyle(layer).transform);
      return m.a; // scaleX
    });
    expect(scale).toBeGreaterThan(1.1);
    await page.screenshot({ path: `${SHOTS}/phone-zoomed.png` });
    // Reset back to fit-width for the next steps.
    await page.getByRole("button", { name: "Fit width" }).click();
  });

  await test.step("(c) landscape re-fits", async () => {
    await page.setViewportSize({ width: 844, height: 390 });
    // The fit observer re-runs; assert the pane still fits the wider width
    // (font within band) and nothing crashed.
    await expect(page.locator(".term-grid").first()).toBeVisible();
    const fontPx = await page.evaluate(() => {
      const el = document.querySelector<HTMLElement>(".wterm");
      return el
        ? parseFloat(getComputedStyle(el).getPropertyValue("--term-font-size"))
        : 0;
    });
    expect(fontPx).toBeGreaterThanOrEqual(6);
    await page.screenshot({ path: `${SHOTS}/phone-landscape.png` });
    // Back to portrait for typing + reflow.
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(page.locator(".term-grid").first()).toBeVisible();
  });

  const marker = `nexus-phone-${Math.floor(Math.random() * 1e9)}`;

  await test.step("(d) soft-keyboard input round-trips (type a command)", async () => {
    // The mobile bridge raises + uses WTerm's hidden textarea. Tap the terminal
    // (touch -> our touchend focus), then type into the textarea. Enter goes
    // through keydown OR our beforeinput bridge; either way it must reach the PTY.
    const surface = page.locator(".term-grid").first();
    await surface.tap();
    const input = page.locator(".wterm textarea").first();
    await expect(input).toBeAttached({ timeout: 10_000 });
    await input.focus();
    // Pace keystrokes to avoid the agent's known send-keys ordering race.
    await page.keyboard.type(`echo ${marker}`, { delay: 75 });
    await page.keyboard.press("Enter");
    await expect
      .poll(() => gridText(page), {
        timeout: 30_000,
        message: "typed marker never rendered — phone keyboard bridge broken",
      })
      .toContain(marker);
    await page.screenshot({ path: `${SHOTS}/phone-typed.png` });
  });

  await test.step("(e) opt-in 'Fit to my screen' reflows the shared pane", async () => {
    // Capture the pre-reflow grid column count, tap reflow, then assert the
    // agent's new geometry frame narrowed the grid to ~phone width and the
    // font-fit settled (readable without zoom).
    const colsBefore = await page.evaluate(() => {
      const row = document.querySelector(".term-grid .term-row");
      return row?.textContent?.length ?? 0;
    });
    await page.getByRole("button", { name: "Fit to my screen" }).click();
    // The pane reflows; CC/bash redraw narrower. Wait for the grid to shrink
    // its column count toward the phone-comfortable target.
    await expect
      .poll(
        () =>
          page.evaluate(() => {
            // widest rendered row ~= current grid cols
            const rows = Array.from(
              document.querySelectorAll(".term-grid .term-row"),
            );
            return rows.reduce(
              (m, r) => Math.max(m, r.textContent?.length ?? 0),
              0,
            );
          }),
        { timeout: 20_000, message: "pane did not reflow narrower after tap" },
      )
      .toBeLessThan(Math.max(colsBefore, 60));
    await page.screenshot({ path: `${SHOTS}/phone-reflowed.png` });
  });
});
