/**
 * [4.2] Kokoro integration-registry journey — the generic `/integrations/:provider`
 * dashboard route driven end to end against the secretless `kokoro` provider.
 *
 * Mirrors `telegram-integration-journey.spec.ts`'s structure and stubbing
 * convention (agent's generic `/integrations/:provider/*` endpoints stubbed
 * at the network layer via `page.route` — t3-testing-patterns Rule 12), but
 * covers Kokoro's distinguishing behavior instead of re-testing the shared
 * masked-secret machinery telegram already exercises:
 *
 *   - `KokoroPanel` renders NO secret input at all (requiresSecret: false) —
 *     just `baseUrl` + `defaultVoice` text fields.
 *   - Save a baseUrl + defaultVoice -> Test Connection (agent route mocked)
 *     -> Delete, exercising the full secretless save/test/delete cycle.
 *   - `/integrations/nope` (never registered) still 404s regardless of the
 *     kokoro addition to `PROVIDER_UI_REGISTRY`.
 *
 * Endpoints stubbed (see apps/web/src/lib/integration-client.ts):
 *   GET    /integrations/kokoro/credentials       masked status
 *   PATCH  /integrations/kokoro/credentials        partial upsert
 *   DELETE /integrations/kokoro/credentials        drop the row (204)
 *   POST   /integrations/kokoro/credentials/test   probe result
 */
import { test, expect } from "@playwright/test";

const BASE_URL = "http://100.73.182.4:8880";
const DEFAULT_VOICE = "af_heart";

test("kokoro: no secret input renders; save -> test (ok) -> delete, then unregistered provider 404s", async ({
  page,
}) => {
  // ── Stateful agent stub: the credential row mutated by PATCH/DELETE. ──────────
  const state: {
    metadata: { baseUrl?: string; defaultVoice?: string };
    lastTestOkAt: string | null;
    lastTestStatusCode: number | null;
  } = {
    metadata: {},
    lastTestOkAt: null,
    lastTestStatusCode: null,
  };
  const credsBody = () => ({
    provider: "kokoro",
    hasSecret: false, // kokoro never stores a secret
    metadata: state.metadata,
    lastTestOkAt: state.lastTestOkAt,
    lastTestStatusCode: state.lastTestStatusCode,
    agentId: "test-agent",
  });

  // The real Kokoro FastAPI /v1/audio/voices probe succeeds for a reachable
  // self-hosted server.
  await page.route("**/integrations/kokoro/credentials/test", (route) => {
    state.lastTestStatusCode = 200;
    state.lastTestOkAt = new Date().toISOString();
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ ok: true, statusCode: 200 }),
    });
  });

  await page.route("**/integrations/kokoro/credentials", (route) => {
    const req = route.request();
    if (req.method() === "PATCH") {
      const patch = JSON.parse(req.postData() ?? "{}") as {
        metadata?: { baseUrl?: string; defaultVoice?: string };
      };
      if (patch.metadata) {
        state.metadata = { ...state.metadata, ...patch.metadata };
      }
    } else if (req.method() === "DELETE") {
      state.metadata = {};
      state.lastTestOkAt = null;
      state.lastTestStatusCode = null;
      return route.fulfill({ status: 204, body: "" });
    }
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(credsBody()),
    });
  });

  // window.confirm() on delete: Playwright auto-dismisses (=> cancel) unless a
  // handler accepts. Accept so the delete actually fires.
  page.on("dialog", (dialog) => void dialog.accept());

  await test.step("registered provider renders its panel with NO secret input (empty state)", async () => {
    await page.goto("/integrations/kokoro");
    await expect(
      page.getByRole("heading", { name: "Kokoro", exact: true }),
    ).toBeVisible();
    // Secretless panel: no masked/password input anywhere on the page.
    await expect(page.locator('input[type="password"]')).toHaveCount(0);
    await expect(page.getByPlaceholder(/100\.73\.182\.4:8880/)).toBeVisible();
    await expect(page.getByPlaceholder(/af_heart/)).toBeVisible();
    // Test + Delete are disabled with no stored baseUrl.
    await expect(page.getByRole("button", { name: "Test connection" })).toBeDisabled();
    await expect(
      page.getByRole("button", { name: "Delete credentials" }),
    ).toBeDisabled();
  });

  await test.step("save a baseUrl + defaultVoice -> Test + Delete become enabled", async () => {
    await page.getByPlaceholder(/100\.73\.182\.4:8880/).fill(BASE_URL);
    await page.getByPlaceholder(/af_heart/).fill(DEFAULT_VOICE);
    await page.getByRole("button", { name: "Save", exact: true }).click();

    await expect(page.getByRole("button", { name: "Test connection" })).toBeEnabled();
    await expect(
      page.getByRole("button", { name: "Delete credentials" }),
    ).toBeEnabled();
  });

  await test.step("test connection -> reachable Kokoro server, rendered as OK", async () => {
    await page.getByRole("button", { name: "Test connection" }).click();
    await expect(page.getByText("Status: 200 — OK")).toBeVisible();
    // The page is still interactive (heading present, no error boundary).
    await expect(
      page.getByRole("heading", { name: "Kokoro", exact: true }),
    ).toBeVisible();
  });

  await test.step("delete -> panel returns to empty/unconfigured state", async () => {
    await page.getByRole("button", { name: "Delete credentials" }).click();
    await expect(page.getByRole("button", { name: "Test connection" })).toBeDisabled();
    await expect(
      page.getByRole("button", { name: "Delete credentials" }),
    ).toBeDisabled();
  });

  await test.step("unregistered provider renders the Next.js 404", async () => {
    const resp = await page.goto("/integrations/nope");
    expect(resp?.status()).toBe(404);
    await expect(page.getByText(/This page could not be found/i)).toBeVisible();
  });
});
