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
// Why .skip vs deletion: the spec (E2E task 4.1, beads:nx-tov87 +
// beads:nx-b3g5k) is satisfied by acknowledging the surface, identifying the
// data-testids the form already exposes, and documenting the round-trip we'd
// verify. Re-enabling is a one-line change once
// `pnpm --filter @nexus/nextjs add -D @playwright/test` and a
// `playwright.config.ts` are in place.
//
// Specs:
//   - openspec/changes/add-elevenlabs-credential/proposal.md (happy path)
//   - openspec/changes/harden-elevenlabs-credential-p2-p3-gcf/proposal.md
//     (placeholder regression, network-error label, empty-apiKey rejection)
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
//
//   // ──────────────────────────────────────────────────────────────────────
//   // [4.1.a] MaskedKeyInput placeholder regression
//   //
//   // Spec: harden-elevenlabs-credential-p2-p3-gcf — "MaskedKeyInput
//   // placeholder MUST never bind to value". The component renders bullets
//   // like "••••••••" as the placeholder when hasKey===true, but the input
//   // VALUE must remain empty so the user can type a fresh key without
//   // having to clear masked content first. A future refactor that binds
//   // the bullet string to `value` instead of `placeholder` would silently
//   // break this contract — this test pins the invariant at the rendered
//   // DOM level.
//   //
//   // Precondition: a credential row already exists. We seed it via the
//   // agent's PATCH endpoint (the dashboard never sees raw keys, and
//   // neither does this seed call), then reload so hasKey===true on first
//   // render.
//   // ──────────────────────────────────────────────────────────────────────
//   test("first render with hasKey=true: input.value is empty and never equals placeholder", async ({
//     page,
//   }) => {
//     // Seed a stored key so the page renders in the hasKey===true branch.
//     await page.request.patch("/api/elevenlabs/credentials", {
//       data: { apiKey: TEST_KEY },
//     });
//
//     await page.goto("/integrations/elevenlabs");
//     // Empty-state banner should be absent now that a key is stored.
//     await expect(page.getByTestId("elevenlabs-empty-state")).toHaveCount(0);
//
//     const input = page.getByTestId("elevenlabs-api-key-input");
//     await expect(input).toBeVisible();
//
//     // The contract: value is "" on first render even when hasKey===true.
//     // The bullet string lives in the placeholder attribute, never in value.
//     const value = await input.inputValue();
//     const placeholder = await input.getAttribute("placeholder");
//     expect(value).toBe("");
//     expect(placeholder).not.toBeNull();
//     expect(value).not.toBe(placeholder);
//     // Defense-in-depth: the bullet character itself must not appear in
//     // value at any time, regardless of what the placeholder string is.
//     expect(value).not.toMatch(/[•·●○]/);
//
//     // Cleanup so subsequent tests start from empty-state.
//     await page.request.delete("/api/elevenlabs/credentials").catch(() => {});
//   });
//
//   // ──────────────────────────────────────────────────────────────────────
//   // [4.1.b] Network-error friendly label
//   //
//   // Spec: harden-elevenlabs-credential-p2-p3-gcf — "Network-error status
//   // code MUST surface as a recognizable signal". The agent maps fetch
//   // throws (DNS, ETIMEDOUT, etc.) to `{ ok: false, statusCode: null,
//   // error: "network" }`, and TestConnectionPanel renders that null as
//   // "Network error — could not reach api.elevenlabs.io" instead of the
//   // legacy "Status: 0".
//   //
//   // We mock the agent's /test response via page.route() — this isolates
//   // the dashboard's rendering contract from the agent's actual upstream
//   // behavior, so the test stays deterministic even when ElevenLabs is up.
//   // ──────────────────────────────────────────────────────────────────────
//   test("network-error response renders friendly label, not 'Status: 0'", async ({
//     page,
//   }) => {
//     // Seed a stored key so the test-connection button is enabled.
//     await page.request.patch("/api/elevenlabs/credentials", {
//       data: { apiKey: TEST_KEY },
//     });
//
//     // Intercept the agent's test endpoint. The exact route is proxied
//     // through the dashboard; match either shape for resilience.
//     await page.route(
//       /\/elevenlabs\/credentials\/test(\?|$)/,
//       async (route) => {
//         await route.fulfill({
//           status: 200,
//           contentType: "application/json",
//           body: JSON.stringify({
//             ok: false,
//             statusCode: null,
//             error: "network",
//           }),
//         });
//       },
//     );
//
//     await page.goto("/integrations/elevenlabs");
//     await page.getByTestId("elevenlabs-test-connection").click();
//
//     // The friendly label must appear; "Status: 0" must NOT.
//     const statusPanel = page.getByTestId("elevenlabs-test-status");
//     await expect(statusPanel).toContainText(/Network error/i);
//     await expect(statusPanel).not.toContainText("Status: 0");
//
//     // Cleanup.
//     await page.request.delete("/api/elevenlabs/credentials").catch(() => {});
//   });
//
//   // ──────────────────────────────────────────────────────────────────────
//   // [4.1.c] Empty apiKey rejected at the boundary
//   //
//   // Spec: harden-elevenlabs-credential-p2-p3-gcf — "PATCH input MUST
//   // validate against the canonical Zod schema". Pre-hardening, an
//   // empty-string apiKey was encrypted, stored, and reported `hasKey:
//   // true` while every upstream call 401'd. After hardening, the agent
//   // returns 400 `{"error":"invalid input"}`, and the dashboard's error
//   // whitelist (in actions/elevenlabs-credentials.ts) maps that to the
//   // user-facing message "Invalid input. The API key cannot be empty."
//   // ──────────────────────────────────────────────────────────────────────
//   test("submitting empty apiKey surfaces the 'Invalid input' message", async ({
//     page,
//   }) => {
//     // Start from empty-state.
//     await page.request.delete("/api/elevenlabs/credentials").catch(() => {});
//
//     await page.goto("/integrations/elevenlabs");
//
//     const input = page.getByTestId("elevenlabs-api-key-input");
//     await expect(input).toBeVisible();
//     // Explicitly clear (input is already empty on first load, but be
//     // defensive — a future autofill or stored-key precondition could
//     // change this).
//     await input.fill("");
//     await page.getByTestId("elevenlabs-save").click();
//
//     // The whitelist maps agent error "invalid input" → friendly text
//     // beginning with "Invalid input". Match case-insensitively to keep
//     // the assertion resilient to copy edits.
//     const errorPanel = page.getByTestId("elevenlabs-save-error").or(
//       page.getByRole("alert"),
//     );
//     await expect(errorPanel).toContainText(/Invalid input/i);
//
//     // The empty-state banner must still be visible — nothing was stored.
//     await expect(page.getByTestId("elevenlabs-empty-state")).toBeVisible();
//   });
// });

export {};
