/**
 * [4.3] Telegram integration-registry journey — the generic `/integrations/:provider`
 * dashboard route driven end to end against a registered provider (`telegram`),
 * plus the unregistered-provider 404.
 *
 * Covers the spec `integration-registry` scenarios:
 *   - "Registered provider renders its panel" — masked bot-token input, chat id
 *     field, and save/test/delete controls all present.
 *   - Save a bot token + chat id -> the panel confirms the secret is stored.
 *   - Test-connection against a fake token -> the panel renders the non-ok
 *     result gracefully (no throw / crash), matching how the real Telegram API
 *     rejects a bogus token.
 *   - Delete -> the panel returns to its empty/unconfigured state.
 *   - "Unregistered provider 404s" — `/integrations/nope` returns Next.js's
 *     standard not-found page (HTTP 404).
 *
 * The agent's generic `/integrations/:provider/*` endpoints AND the upstream
 * Telegram Bot API are STUBBED at the network layer via `page.route`
 * (t3-testing-patterns Rule 12 — third-party/agent APIs in e2e are mocked,
 * never live), so this spec needs only the web server, not a running agent, a
 * real bot token, or a reachable Telegram API. The stub is stateful across
 * GET/PATCH/DELETE so the empty -> saved -> tested -> deleted transitions are
 * exercised for real in the browser.
 *
 * Endpoints stubbed (see apps/web/src/lib/integration-client.ts):
 *   GET    /integrations/telegram/credentials       masked status
 *   PATCH  /integrations/telegram/credentials        partial upsert
 *   DELETE /integrations/telegram/credentials        drop the row (204)
 *   POST   /integrations/telegram/credentials/test   probe result
 */
import { test, expect } from "@playwright/test";

const CHAT_ID = "123456789";
const BOT_TOKEN = "123456:FAKE-telegram-bot-token-for-e2e";

test("save -> test (rejected) -> delete, then unregistered provider 404s", async ({
  page,
}) => {
  // ── Stateful agent stub: the credential row mutated by PATCH/DELETE. ──────────
  const state: {
    hasSecret: boolean;
    chatId: string;
    lastTestOkAt: string | null;
    lastTestStatusCode: number | null;
  } = {
    hasSecret: false,
    chatId: "",
    lastTestOkAt: null,
    lastTestStatusCode: null,
  };
  const credsBody = () => ({
    provider: "telegram",
    hasSecret: state.hasSecret,
    metadata: state.chatId ? { chatId: state.chatId } : {},
    lastTestOkAt: state.lastTestOkAt,
    lastTestStatusCode: state.lastTestStatusCode,
    agentId: "test-agent",
  });

  // A fake token: the real Bot API `getMe` returns 401, so the probe is not-ok.
  await page.route("**/integrations/telegram/credentials/test", (route) => {
    state.lastTestStatusCode = 401;
    state.lastTestOkAt = null; // 2xx-only per the descriptor contract
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ ok: false, statusCode: 401 }),
    });
  });

  await page.route("**/integrations/telegram/credentials", (route) => {
    const req = route.request();
    if (req.method() === "PATCH") {
      const patch = JSON.parse(req.postData() ?? "{}") as {
        secret?: string;
        metadata?: { chatId?: string };
      };
      if (patch.secret) state.hasSecret = true;
      if (typeof patch.metadata?.chatId === "string") {
        state.chatId = patch.metadata.chatId;
      }
    } else if (req.method() === "DELETE") {
      state.hasSecret = false;
      state.chatId = "";
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

  await test.step("registered provider renders its panel (empty state)", async () => {
    await page.goto("/integrations/telegram");
    await expect(
      page.getByRole("heading", { name: "Telegram", exact: true }),
    ).toBeVisible();
    // Masked bot-token input, chat id field, and the three controls are present.
    await expect(page.locator('input[type="password"]')).toBeVisible();
    await expect(page.getByPlaceholder(/123456789/)).toBeVisible();
    await expect(page.getByRole("button", { name: "Save", exact: true })).toBeVisible();
    // Test + Delete are disabled with no stored secret.
    await expect(page.getByRole("button", { name: "Test connection" })).toBeDisabled();
    await expect(
      page.getByRole("button", { name: "Delete credentials" }),
    ).toBeDisabled();
  });

  await test.step("save a bot token + chat id -> secret is stored", async () => {
    await page.locator('input[type="password"]').fill(BOT_TOKEN);
    await page.getByPlaceholder(/123456789/).fill(CHAT_ID);
    await page.getByRole("button", { name: "Save", exact: true }).click();
    // Visible confirmation: MaskedKeyInput flips to "(a key is stored)".
    await expect(page.getByText("(a key is stored)")).toBeVisible();
    // Test + Delete now enabled (hasSecret && chatId present).
    await expect(page.getByRole("button", { name: "Test connection" })).toBeEnabled();
    await expect(
      page.getByRole("button", { name: "Delete credentials" }),
    ).toBeEnabled();
  });

  await test.step("test connection -> fake token rejected, rendered gracefully", async () => {
    await page.getByRole("button", { name: "Test connection" }).click();
    // The panel renders the non-ok status without crashing.
    await expect(page.getByText("Status: 401 — request rejected")).toBeVisible();
    // The page is still interactive (heading present, no error boundary).
    await expect(
      page.getByRole("heading", { name: "Telegram", exact: true }),
    ).toBeVisible();
  });

  await test.step("delete -> panel returns to empty/unconfigured state", async () => {
    await page.getByRole("button", { name: "Delete credentials" }).click();
    await expect(page.getByText("(a key is stored)")).toBeHidden();
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
