/**
 * [nx-2pekj VERIFY] Desktop attach to a REAL wide CC session must show LIVE
 * content immediately on load — no manual scroll. This is the surface that
 * regressed (Leo's blank terminal on cc-2164338-51c4d51e). Not part of CI
 * (depends on a specific live session); run ad-hoc for the screenshot proof.
 */
import { test, expect, type Page } from "@playwright/test";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const SHOTS = join(HERE, "..", "..", "..", "docs", "screenshots");

const WIDE_SESSION = process.env.NX_WIDE_SESSION ?? "cc-2164338-51c4d51e";

const gridText = (p: Page) =>
  p.locator(".term-grid").first().textContent().then((t) => t ?? "");

test("desktop attach to wide CC session shows live content immediately", async ({
  page,
  viewport,
}) => {
  test.skip(!viewport || viewport.width < 1000, "desktop project only");

  await page.goto(`/attach/${encodeURIComponent(WIDE_SESSION)}`);
  await expect(page.locator(".term-grid").first()).toBeVisible({ timeout: 30_000 });
  // Wait for real content (CC TUI paints something non-empty).
  await expect.poll(() => gridText(page), { timeout: 30_000 }).not.toEqual("");

  // Give the scrollback flush + stick-to-bottom a moment to settle, then assert
  // — WITHOUT any manual scroll — that the viewport is at the live bottom and
  // the bottom-most non-empty row is inside the visible viewport band.
  await page.waitForTimeout(1500);
  const state = await page.evaluate(() => {
    const host = document.querySelector<HTMLElement>(".wterm");
    if (!host) return null;
    const rowH =
      parseFloat(getComputedStyle(host).getPropertyValue("--term-row-height")) || 17;
    const distFromBottom = host.scrollHeight - host.scrollTop - host.clientHeight;
    // Find the bottom-most row with visible text and check it's in the viewport.
    const rows = Array.from(host.querySelectorAll<HTMLElement>(".term-row"));
    const lastText = [...rows].reverse().find((r) => (r.textContent ?? "").trim());
    let lastVisible = false;
    if (lastText) {
      const hb = host.getBoundingClientRect();
      const rb = lastText.getBoundingClientRect();
      const mid = rb.top + rb.height / 2;
      lastVisible = mid >= hb.top && mid <= hb.bottom;
    }
    return {
      overflows: host.scrollHeight - host.clientHeight > rowH,
      atBottom: distFromBottom <= rowH * 2,
      lastVisible,
      fontPx: parseFloat(getComputedStyle(host).getPropertyValue("--term-font-size")),
    };
  });
  console.log(`[DESKTOP-ATTACH] ${WIDE_SESSION} ${JSON.stringify(state)}`);

  await page.screenshot({ path: `${SHOTS}/desktop-attach-fixed.png` });

  expect(state).not.toBeNull();
  // Live content must be inside the visible viewport on attach (the regression
  // had rows in the DOM but scrolled out of view).
  expect(state!.atBottom, "viewport not pinned to live bottom on attach").toBe(true);
  expect(state!.lastVisible, "bottom-most content row not in visible viewport").toBe(
    true,
  );
});
