// notification-push.e2e.test.ts — task 4.3 (nx-6syfl).
//
// E2E: a `NotificationFired` lifecycle event (the kind raised for a session whose
// iOS app is killed — only a VISIBLE alert push, not a silent one, can surface on a
// killed app) results in an ACTUAL APNs send, verified against a mocked/sandboxed
// APNs endpoint.
//
// This drives the REAL send path end-to-end: NotificationPushSubscriber → the real
// ApnsSender (ES256 JWT + HTTP/2 request in apns-sender.ts) → a local HTTP/2 server
// standing in for api.push.apple.com. Nothing in the push path is stubbed; only the
// far endpoint is a sandbox. Plaintext h2c (`http://…`) is used so no TLS cert
// plumbing is needed — `http2.connect` speaks h2c to `http2.createServer`.
//
// Env (APNS_KEY_PATH / APNS_HOST / HEALTH_PUSH_TOKEN_PATH) is set BEFORE the first
// getApnsSender()/getDeviceTokenStore() call (both lazy singletons) so the real
// ~/.config store and the real Apple endpoint are never touched. No source file
// under test is modified — this exercises the shipped implementation as-is.

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Http2Server } from "node:http2";
import { tmpdir } from "node:os";
import { join } from "node:path";

// ── temp workspace + a real ES256 (EC P-256) key so ApnsSender constructs ──────
const tmpDir = mkdtempSync(join(tmpdir(), "nx-apns-e2e-"));
const keyPath = join(tmpDir, "AuthKey_TEST.p8");
const { privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
writeFileSync(keyPath, privateKey.export({ type: "pkcs8", format: "pem" }) as string);

process.env.APNS_KEY_PATH = keyPath;
process.env.APNS_KEY_ID = "TESTKEYID1";
process.env.APNS_TEAM_ID = "TESTTEAM01";
process.env.APNS_BUNDLE_ID = "dev.leonardoacosta.nexus.ios";
process.env.HEALTH_PUSH_TOKEN_PATH = join(tmpDir, "apns-device-tokens.json");

const { getDeviceTokenStore } = await import("./device-token-store");
const { NotificationPushSubscriber, composeTitle } = await import("./notification-push");
const { LifecycleBus } = await import("../services/lifecycle-bus");

const DEVICE_TOKEN = "f".repeat(64);

interface CapturedRequest {
  method: string;
  path: string;
  headers: Record<string, string | undefined>;
  body: string;
}

let server: Http2Server;
const captured: CapturedRequest[] = [];

beforeAll(async () => {
  server = createServer();
  server.on("stream", (stream, headers) => {
    let body = "";
    stream.on("data", (c) => (body += c));
    stream.on("end", () => {
      captured.push({
        method: String(headers[":method"]),
        path: String(headers[":path"]),
        headers: {
          "apns-push-type": headers["apns-push-type"] as string | undefined,
          "apns-priority": headers["apns-priority"] as string | undefined,
          "apns-topic": headers["apns-topic"] as string | undefined,
          authorization: headers["authorization"] as string | undefined,
        },
        body,
      });
      // Mimic APNs "accepted": 200 with an empty body.
      stream.respond({ ":status": 200 });
      stream.end();
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;
  // Point the sender at the sandbox endpoint over plaintext HTTP/2.
  process.env.APNS_HOST = `http://127.0.0.1:${port}`;

  // getDeviceTokenStore() is a PROCESS-GLOBAL singleton keyed at first
  // construction. A sibling suite (routes/apns-register.test.ts) registers
  // throwaway tokens ("a"×64 / "b"×64) into that same singleton earlier in the
  // full-suite run, and the subscriber fans a push out to ALL registered
  // devices — so without draining, captured[0] is a leaked foreign token and
  // the path assertion below fails (nx-uwive). Drain any leaked tokens first so
  // this e2e asserts against exactly its own registered device.
  const store = getDeviceTokenStore();
  for (const existing of await store.all()) await store.remove(existing.token);
  await store.register({
    token: DEVICE_TOKEN,
    platform: "ios",
    bundleId: "dev.leonardoacosta.nexus.ios",
  });
});

afterAll(() => {
  server.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

async function waitForRequest(timeoutMs = 3000): Promise<CapturedRequest> {
  const start = Date.now();
  while (captured.length === 0) {
    if (Date.now() - start > timeoutMs) throw new Error("no APNs request received");
    await new Promise((r) => setTimeout(r, 25));
  }
  return captured[0]!;
}

describe("NotificationFired -> APNs alert push (task 4.3)", () => {
  it("sends an actual alert push to the registered device for a session notification", async () => {
    const bus = new LifecycleBus();
    const subscriber = new NotificationPushSubscriber(bus);
    subscriber.start();

    // A session-originated notification — the app on that device may be killed,
    // so a visible alert push is the only thing that can surface.
    bus.emit("NotificationFired", {
      id: "notif-killed-app-1",
      title: "Task complete",
      body: "Your build finished",
      channel: "desktop",
      project: "nexus",
      sessionName: "fix-login-flow",
      sessionId: "sess-abc-123",
    });

    const req = await waitForRequest();

    // Reached the real Apple device endpoint for OUR token.
    expect(req.method).toBe("POST");
    expect(req.path).toBe(`/3/device/${DEVICE_TOKEN}`);
    // A visible alert push (priority 10), not a silent/background one.
    expect(req.headers["apns-push-type"]).toBe("alert");
    expect(req.headers["apns-priority"]).toBe("10");
    expect(req.headers["apns-topic"]).toBe("dev.leonardoacosta.nexus.ios");
    expect(req.headers.authorization).toMatch(/^bearer .+/);

    const payload = JSON.parse(req.body) as {
      aps: { alert: { title: string; body: string } };
      sessionId?: string;
      notificationId?: string;
    };
    expect(payload.aps.alert.title).toBe("nexus · fix-login-flow");
    expect(payload.aps.alert.body).toBe("Your build finished");
    // The tap-router deep-link key rides in userInfo.
    expect(payload.sessionId).toBe("sess-abc-123");
    expect(payload.notificationId).toBe("notif-killed-app-1");

    bus.removeAllListeners();
  });
});

// ─── composeTitle — duplicate-prefix guard (drop-permission-request-tts-draft, nx-bidsj.3) ──
//
// Unit-style cases (no APNs round-trip needed — composeTitle is a pure
// function). CC session names are conventionally `<code> · <branch>`-shaped;
// blind `<project> · <session>` concatenation would double the project
// segment (e.g. project "cc", session_name "cc · main" -> "cc · cc · main").

describe("composeTitle — duplicate-prefix guard", () => {
  it("skips the project segment when the session name already starts with '<project> · '", () => {
    expect(composeTitle("cc", "cc · main")).toBe("cc · main");
  });

  it("skips the project segment when the session name equals the project outright", () => {
    expect(composeTitle("cc", "cc")).toBe("cc");
  });

  it("composes '<project> · <session>' as today for an unrelated session name", () => {
    expect(composeTitle("nexus", "fix-login-flow")).toBe("nexus · fix-login-flow");
  });

  it("does not false-positive on a session name that merely starts with the project as a substring", () => {
    // "ccx · main" starts with "cc" but NOT with the exact "cc · " prefix —
    // must NOT be treated as already-prefixed.
    expect(composeTitle("cc", "ccx · main")).toBe("cc · ccx · main");
  });

  it("degrades gracefully when only one of project/session is present", () => {
    expect(composeTitle(undefined, "fix-login-flow")).toBe("fix-login-flow");
    expect(composeTitle("nexus", undefined)).toBe("nexus");
    expect(composeTitle(undefined, undefined, "fallback title")).toBe("fallback title");
    expect(composeTitle()).toBe("Nexus");
  });
});
