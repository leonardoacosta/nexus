// apns-register.test.ts — task 4.2 (nx-xwnqx). Unit test for POST /apns/register:
// a well-formed device token is stored and gets a non-404 (200) response, while
// malformed input is rejected at the boundary.
//
// The route uses the module-singleton DeviceTokenStore, whose persistence path is
// controlled by HEALTH_PUSH_TOKEN_PATH. We point it at a throwaway temp file BEFORE
// the first getDeviceTokenStore() call so the real ~/.config store is never touched.

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tmpDir = mkdtempSync(join(tmpdir(), "nx-apns-register-"));
process.env.HEALTH_PUSH_TOKEN_PATH = join(tmpDir, "apns-device-tokens.json");

const { handleApnsRegister } = await import("./apns-register");
const { getDeviceTokenStore } = await import("../health-push/device-token-store");

// A valid APNs device token is 64+ hex chars (see apns-register HEX_TOKEN).
const VALID_TOKEN = "a".repeat(64);

function postJson(body: unknown): Request {
  return new Request("http://localhost/apns/register", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

afterAll(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("POST /apns/register (task 4.2)", () => {
  it("stores a valid token and responds 200 (not 404)", async () => {
    const res = await handleApnsRegister(
      postJson({ platform: "ios", token: VALID_TOKEN, bundleId: "dev.leonardoacosta.nexus.ios" }),
    );

    // Non-404 response — the route is wired and accepts the registration.
    expect(res.status).not.toBe(404);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });

    // Token was persisted into the store.
    const tokens = await getDeviceTokenStore().all();
    const stored = tokens.find((t) => t.token === VALID_TOKEN);
    expect(stored).toBeDefined();
    expect(stored?.platform).toBe("ios");
    expect(stored?.bundleId).toBe("dev.leonardoacosta.nexus.ios");
  });

  it("upserts (idempotent) — re-registering the same token does not duplicate it", async () => {
    await handleApnsRegister(postJson({ token: VALID_TOKEN }));
    const tokens = await getDeviceTokenStore().all();
    expect(tokens.filter((t) => t.token === VALID_TOKEN).length).toBe(1);
  });

  it("defaults platform to ios when omitted", async () => {
    const token = "b".repeat(64);
    const res = await handleApnsRegister(postJson({ token }));
    expect(res.status).toBe(200);
    const stored = (await getDeviceTokenStore().all()).find((t) => t.token === token);
    expect(stored?.platform).toBe("ios");
  });

  it("rejects a missing token with 400", async () => {
    const res = await handleApnsRegister(postJson({ platform: "ios" }));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "missing or malformed device token" });
  });

  it("rejects a malformed (non-hex / too-short) token with 400", async () => {
    const res = await handleApnsRegister(postJson({ token: "not-a-real-token" }));
    expect(res.status).toBe(400);
  });

  it("rejects an invalid JSON body with 400", async () => {
    const req = new Request("http://localhost/apns/register", {
      method: "POST",
      body: "{ not json",
    });
    const res = await handleApnsRegister(req);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "invalid JSON body" });
  });
});
