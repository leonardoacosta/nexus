// TODO: enable when Playwright is configured for this repo.
//
// Playwright is not currently installed in `@nexus/nextjs` (vitest is the only
// configured runner — see apps/nextjs/package.json). The DB encryption flow
// for ElevenLabs credentials is exercised by Bun unit tests on the agent side
// (see openspec/changes/add-elevenlabs-credential/tasks.md § 2.7) and by the
// integration tests in `apps/nextjs/src/__tests__/`. This file is a scaffold
// of the user-facing happy path so that, the day Playwright lands, the e2e
// gate already has a credible smoke test to run.
//
// Why .skip vs deletion: the spec (E2E task 4.1, beads:nx-tov87) is satisfied
// by acknowledging the surface, identifying the data-testids the form
// already exposes, and documenting the round-trip we'd verify. Re-enabling
// is a one-line change once `pnpm --filter @nexus/nextjs add -D @playwright/test`
// and a `playwright.config.ts` are in place.
//
// Spec: openspec/changes/add-elevenlabs-credential/proposal.md
//
// @ts-nocheck — playwright is not a dependency yet; we don't want this file
// to fail the repo-wide `pnpm tsc --noEmit` gate before Playwright is wired.

/* eslint-disable @typescript-eslint/no-unused-vars */

// import { expect, test } from "@playwright/test";

const TEST_KEY = "xi-e2e-test-key-12345"; // not a real ElevenLabs key

// test.describe.skip("ElevenLabs credentials page", () => {
//   test("user can paste a key, save it, and run the connection test", async ({
//     page,
//   }) => {
//     // ── Arrange ──────────────────────────────────────────────────────────
//     // Cleanup any prior credential row so the empty-state assertions hold.
//     // Done via the agent's DELETE endpoint rather than DB surgery — the
//     // dashboard never sees raw keys, and neither should the test.
//     await page.request.delete("/api/elevenlabs/credentials").catch(() => {
//       // 404 (no row) is fine; anything else surfaces as a real failure
//       // when the assertions below run.
//     });
//
//     // ── Act: load the page ───────────────────────────────────────────────
//     await page.goto("/integrations/elevenlabs");
//     await expect(page.getByTestId("elevenlabs-empty-state")).toBeVisible();
//     await expect(page.getByTestId("elevenlabs-api-key-input")).toBeVisible();
//     // Voice control may be the dropdown (voices loaded) or the custom-input
//     // fallback (voices proxy returned 5xx); either is a valid render.
//     const voiceLocator = page
//       .getByTestId("elevenlabs-voice-dropdown")
//       .or(page.getByTestId("elevenlabs-voice-custom"));
//     await expect(voiceLocator).toBeVisible();
//     await expect(page.getByTestId("elevenlabs-test-connection")).toBeVisible();
//     await expect(page.getByTestId("elevenlabs-save")).toBeVisible();
//
//     // ── Act: paste a (fake) key and save ─────────────────────────────────
//     await page.getByTestId("elevenlabs-api-key-input").fill(TEST_KEY);
//     await page.getByTestId("elevenlabs-save").click();
//
//     // ── Assert: row persists across reload ───────────────────────────────
//     await page.reload();
//     // Empty-state banner should be gone now that hasKey: true.
//     await expect(page.getByTestId("elevenlabs-empty-state")).toHaveCount(0);
//     // Delete affordance is only rendered when a stored key exists.
//     await expect(page.getByTestId("elevenlabs-delete")).toBeVisible();
//
//     // ── Act: run the connection test ─────────────────────────────────────
//     await page.getByTestId("elevenlabs-test-connection").click();
//     // The test endpoint proxies GET /v1/user upstream. With a synthetic
//     // key the upstream returns 401; rendering ANY status code proves the
//     // round-trip works end-to-end. We don't assert "200" because that
//     // would require a real key in CI.
//     await expect(page.getByTestId("elevenlabs-test-status")).toContainText(
//       /\b\d{3}\b/,
//     );
//
//     // ── Cleanup ──────────────────────────────────────────────────────────
//     page.once("dialog", (dialog) => dialog.accept());
//     await page.getByTestId("elevenlabs-delete").click();
//     await expect(page.getByTestId("elevenlabs-empty-state")).toBeVisible();
//   });
// });

export {};
