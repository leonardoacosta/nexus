/**
 * [nx-2pekj VERIFY] Manual verification against a REAL WIDE CC pane.
 *
 * Unlike the controlled-bash journey spec, this attaches to a LIVE 218-col
 * `claude` TUI session (cc-3930025-7a40881a, tmux 0:1.4) to exercise the actual
 * phone problem: a wide pane font-fitted onto a 390px screen, where the
 * legibility floor and zoom/reflow matter. It is READ-ONLY w.r.t. typing — we
 * never send keystrokes into Leo's live session; the only mutation is the
 * explicit reflow tap (transient, self-corrects when a wider client reattaches).
 *
 * NOT part of the CI suite — it depends on a specific live session id. Run
 * ad-hoc to capture the docs/screenshots/phone-wide-*.png evidence.
 */
import { test, expect, type Page } from "@playwright/test";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const SHOTS = join(HERE, "..", "..", "..", "docs", "screenshots");

// The live wide CC session (218 cols). Overridable for re-runs.
const WIDE_SESSION = process.env.NX_WIDE_SESSION ?? "cc-3930025-7a40881a";
const attachHref = `/attach/${encodeURIComponent(WIDE_SESSION)}`;

const gridText = (p: Page) =>
  p.locator(".term-grid").first().textContent().then((t) => t ?? "");

/**
 * A live CC TUI paints its prompt + status line at the BOTTOM of the viewport;
 * the upper rows are often blank. Scroll the .wterm host to the bottom so the
 * screenshot frames the actual content, not the empty top.
 */
async function scrollToContent(page: Page) {
  await page.evaluate(() => {
    const el = document.querySelector<HTMLElement>(".wterm");
    if (el) el.scrollTop = el.scrollHeight;
  });
  await page.waitForTimeout(200);
}

/** Read the live fit state: font-size px + the widest rendered row length. */
async function fitState(page: Page) {
  return page.evaluate(() => {
    const el = document.querySelector<HTMLElement>(".wterm");
    const fontPx = el
      ? parseFloat(getComputedStyle(el).getPropertyValue("--term-font-size"))
      : 0;
    const rows = Array.from(document.querySelectorAll(".term-grid .term-row"));
    const cols = rows.reduce((m, r) => Math.max(m, r.textContent?.length ?? 0), 0);
    return { fontPx, cols };
  });
}

async function pinchOut(page: Page) {
  // Target the GESTURE SURFACE (the div carrying the touch handlers), which is
  // the .wterm host's grandparent: surface > transform-layer > .wterm.
  const box = await page.evaluate(() => {
    const host = document.querySelector<HTMLElement>(".wterm");
    const surface = host?.parentElement?.parentElement;
    if (!surface) return null;
    const r = surface.getBoundingClientRect();
    return { x: r.x, y: r.y, w: r.width, h: r.height };
  });
  if (!box) throw new Error("no gesture surface");
  const cx = box.x + box.w * 0.25;
  const cy = box.y + box.h * 0.55;
  await page.evaluate(
    ({ cx, cy }) => {
      const host = document.querySelector<HTMLElement>(".wterm");
      const target = host?.parentElement?.parentElement; // the gesture surface
      if (!target) return;
      const mk = (type: string, pts: { id: number; x: number; y: number }[]) => {
        const ts = pts.map(
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
      mk("touchstart", [
        { id: 0, x: cx - 30, y: cy },
        { id: 1, x: cx + 30, y: cy },
      ]);
      // Spread to ~2.7x (legible window, not the 6x cap).
      for (let i = 1; i <= 6; i++) {
        const spread = 30 + i * 14;
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

test("WIDE CC pane on a phone: default fit + zoom + reflow", async ({
  page,
  viewport,
  hasTouch,
}) => {
  test.skip(!viewport || viewport.width > 500, "phone project only");
  expect(hasTouch).toBe(true);

  await page.goto(attachHref);
  await expect(page.locator(".term-grid").first()).toBeVisible({ timeout: 30_000 });
  // Live CC session: wait for a real render (the TUI paints box-drawing / prompt).
  await expect
    .poll(() => gridText(page), { timeout: 30_000 })
    .not.toEqual("");

  await test.step("(1) default fit-width scaled view of the WIDE pane", async () => {
    // Let the fit settle, then scroll to the live content (bottom of viewport).
    await page.waitForTimeout(1500);
    await scrollToContent(page);
    const before = await fitState(page);
    // Emit the numbers to the test log so the report can quote them exactly.
    console.log(
      `[WIDE-DEFAULT] session=${WIDE_SESSION} fontPx=${before.fontPx} renderedCols=${before.cols}`,
    );
    await page.screenshot({ path: `${SHOTS}/phone-wide-default.png` });
    // The fit must respect the floor (>=6px) and never upscale past base (14px).
    expect(before.fontPx).toBeGreaterThanOrEqual(6);
    expect(before.fontPx).toBeLessThanOrEqual(14);
  });

  await test.step("(2) pinch-zoom engaged on the wide pane (scale>1.5)", async () => {
    await scrollToContent(page);
    await pinchOut(page);
    const scale = await page.evaluate(() => {
      const host = document.querySelector<HTMLElement>(".wterm");
      const layer = host?.parentElement;
      if (!layer) return 1;
      return new DOMMatrixReadOnly(getComputedStyle(layer).transform).a;
    });
    console.log(`[WIDE-ZOOM] scale=${scale}`);
    expect(scale).toBeGreaterThan(1.5);
    await page.screenshot({ path: `${SHOTS}/phone-wide-zoomed.png` });
    await page.getByRole("button", { name: "Fit width" }).click();
  });

  await test.step("(3) reflow the wide pane to phone width", async () => {
    const before = await fitState(page);
    await page.getByRole("button", { name: "Fit to my screen" }).click();
    // CC redraws narrow; wait for the grid to shrink toward phone-comfortable cols.
    await expect
      .poll(() => fitState(page).then((s) => s.cols), {
        timeout: 25_000,
        message: "wide pane did not reflow narrower after tap",
      })
      .toBeLessThan(before.cols);
    await page.waitForTimeout(1500); // let CC finish the redraw
    await scrollToContent(page);
    const after = await fitState(page);
    console.log(
      `[WIDE-REFLOW] beforeCols=${before.cols} afterCols=${after.cols} afterFontPx=${after.fontPx}`,
    );
    await page.screenshot({ path: `${SHOTS}/phone-wide-reflowed.png` });
  });
});
