/**
 * [4.1] ElevenLabs credential journey — paste key -> pick voice -> Save -> Test.
 *
 * Drives the `/integrations/elevenlabs` page end to end: enter an API key in the
 * masked input, choose a voice from the proxied dropdown, Save, then Test the
 * connection and assert the status-code render (TestConnectionPanel).
 *
 * The agent + upstream ElevenLabs API are STUBBED at the network layer via
 * `page.route` (Rule 12 — third-party APIs in e2e are mocked, never live), so
 * this spec needs only the web server, not a running agent or a real key. The
 * stub tracks credential state across GET/PATCH so the Save -> "key is stored"
 * -> Test-enabled transition is exercised for real in the browser.
 *
 * Endpoints stubbed (see apps/web/src/lib/elevenlabs-client.ts):
 *   GET    /elevenlabs/credentials       masked status
 *   PATCH  /elevenlabs/credentials       partial upsert
 *   GET    /elevenlabs/voices            voice list
 *   POST   /elevenlabs/credentials/test  probe result + quota
 */
import { test, expect } from "@playwright/test";

const VOICE_ID = "21m00Tcm4TlvDq8ikWAM";
const VOICE_NAME = "Rachel";

test("paste key, pick voice, Save, Test -> status 200 render", async ({ page }) => {
  // ── Stateful agent stub: credential row mutated by PATCH ──────────────────
  const state: {
    hasKey: boolean;
    voiceId: string | null;
    voiceName: string | null;
    lastTestOkAt: string | null;
    lastTestStatusCode: number | null;
  } = {
    hasKey: false,
    voiceId: null,
    voiceName: null,
    lastTestOkAt: null,
    lastTestStatusCode: null,
  };
  const credsBody = () => ({ ...state, agentId: "test-agent" });

  await page.route("**/elevenlabs/voices", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        voices: [
          { voiceId: VOICE_ID, name: VOICE_NAME, labels: { language: "en" } },
          { voiceId: "AZnzlk1XvdvUeBnXmlld", name: "Domi" },
        ],
      }),
    }),
  );

  await page.route("**/elevenlabs/credentials/test", (route) => {
    state.lastTestStatusCode = 200;
    state.lastTestOkAt = new Date().toISOString();
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        ok: true,
        statusCode: 200,
        subscription: {
          tier: "creator",
          characterCount: 1234,
          characterLimit: 100000,
          nextResetUnix: 0,
        },
      }),
    });
  });

  await page.route("**/elevenlabs/credentials", (route) => {
    const req = route.request();
    if (req.method() === "PATCH") {
      const patch = JSON.parse(req.postData() ?? "{}") as {
        apiKey?: string;
        voiceId?: string;
      };
      if (patch.apiKey) state.hasKey = true;
      if (patch.voiceId !== undefined) {
        state.voiceId = patch.voiceId;
        state.voiceName = patch.voiceId === VOICE_ID ? VOICE_NAME : patch.voiceId;
      }
    }
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(credsBody()),
    });
  });

  await test.step("open the page with no stored credential", async () => {
    await page.goto("/integrations/elevenlabs");
    await expect(
      page.getByRole("heading", { name: "ElevenLabs", exact: true }),
    ).toBeVisible();
    // Test button is disabled until a key is saved.
    await expect(page.getByRole("button", { name: "Test connection" })).toBeDisabled();
  });

  await test.step("paste an API key and pick a voice", async () => {
    await page.locator('input[type="password"]').fill("sk_test_journey_key");
    // The dropdown renders a <select> once the proxied voice list loads.
    const select = page.locator("select");
    await expect(select).toBeVisible();
    await select.selectOption(VOICE_ID);
  });

  await test.step("Save -> key is stored, Test becomes enabled", async () => {
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await expect(page.getByText("(a key is stored)")).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Test connection" }),
    ).toBeEnabled();
  });

  await test.step("Test connection -> renders status 200 + quota", async () => {
    await page.getByRole("button", { name: "Test connection" }).click();
    await expect(page.getByText("Status: 200 — OK")).toBeVisible();
    await expect(page.getByText("1234 / 100000 chars")).toBeVisible();
  });
});
