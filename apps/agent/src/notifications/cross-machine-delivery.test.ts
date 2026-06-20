/**
 * Cross-machine forward tests (openspec/changes/cross-machine-delivery, Phase 1.6).
 *
 * `forwardOrLocal` is the push-to-peer hop with a lossless local fallback:
 *
 *  - target === local        → returns false (caller delivers locally), no POST
 *  - remote reachable + 2xx  → POSTs to the peer's /notifications/deliver,
 *                              returns true (peer accepted)
 *  - remote unreachable / non-2xx / timeout → returns false (local fallback)
 *                              and logs warn — a notification is NEVER dropped
 *
 * Deps (fetch + peer lookup) are injected so the test runs without a live peer.
 */

import { describe, expect, it, beforeEach, mock } from "bun:test";

const loggerMock = {
  info: mock(() => {}),
  warn: mock(() => {}),
  error: mock(() => {}),
  debug: mock(() => {}),
  fatal: mock(() => {}),
  child: () => loggerMock,
};

mock.module("@nexus/core/node", () => ({
  logger: loggerMock,
  createLogger: () => loggerMock,
  getAgentId: mock(() => "test-agent"),
}));

// Load the SUT AFTER the mock is registered so its top-level createLogger()
// call binds to the mock (matches the manager.audio.test pattern).
const { forwardOrLocal } = await import("./cross-machine-delivery");
import type {
  ForwardableNotification,
  ForwardDeps,
} from "./cross-machine-delivery";

const notification: ForwardableNotification = {
  id: "n1",
  title: "Build done",
  body: "tc green",
  channel: "tts",
  project: "tc",
};

function makeDeps(over: Partial<ForwardDeps>): ForwardDeps {
  return {
    lookupPeer: async () => ({ host: "100.64.0.2", port: 7400 }),
    fetchImpl: async () => new Response(null, { status: 200 }),
    secret: "test-secret",
    ...over,
  };
}

describe("forwardOrLocal", () => {
  beforeEach(() => {
    loggerMock.warn.mockClear();
  });

  it("returns false and does NOT forward when target is local", async () => {
    let fetched = false;
    const deps = makeDeps({
      fetchImpl: async () => {
        fetched = true;
        return new Response(null, { status: 200 });
      },
    });
    const result = await forwardOrLocal(notification, "laptop", "laptop", deps);
    expect(result).toBe(false);
    expect(fetched).toBe(false);
  });

  it("POSTs to the peer and returns true when remote target is reachable", async () => {
    let capturedUrl = "";
    let capturedInit: RequestInit | undefined;
    const deps = makeDeps({
      lookupPeer: async () => ({ host: "100.64.0.9", port: 7400 }),
      fetchImpl: async (url, init) => {
        capturedUrl = String(url);
        capturedInit = init;
        return new Response(JSON.stringify({ ok: true }), { status: 202 });
      },
    });
    const result = await forwardOrLocal(notification, "studio", "laptop", deps);
    expect(result).toBe(true);
    expect(capturedUrl).toBe("http://100.64.0.9:7400/notifications/deliver");
    expect(capturedInit?.method).toBe("POST");
    const headers = new Headers(capturedInit?.headers);
    expect(headers.get("x-nexus-secret")).toBe("test-secret");
    expect(headers.get("content-type")).toContain("application/json");
    const sent = JSON.parse(String(capturedInit?.body)) as { id: string; title: string };
    expect(sent.id).toBe("n1");
    expect(sent.title).toBe("Build done");
  });

  it("returns false (lossless fallback) + warns when the peer is unknown", async () => {
    const deps = makeDeps({ lookupPeer: async () => null });
    const result = await forwardOrLocal(notification, "studio", "laptop", deps);
    expect(result).toBe(false);
    expect(loggerMock.warn).toHaveBeenCalled();
  });

  it("returns false (lossless fallback) + warns on a non-2xx peer response", async () => {
    const deps = makeDeps({
      fetchImpl: async () => new Response("nope", { status: 500 }),
    });
    const result = await forwardOrLocal(notification, "studio", "laptop", deps);
    expect(result).toBe(false);
    expect(loggerMock.warn).toHaveBeenCalled();
  });

  it("returns false (lossless fallback) + warns when the fetch throws (unreachable/timeout)", async () => {
    const deps = makeDeps({
      fetchImpl: async () => {
        throw new Error("ECONNREFUSED");
      },
    });
    const result = await forwardOrLocal(notification, "studio", "laptop", deps);
    expect(result).toBe(false);
    expect(loggerMock.warn).toHaveBeenCalled();
  });

  it("does not re-forward a notification already marked forwarded (loop guard)", async () => {
    let fetched = false;
    const deps = makeDeps({
      fetchImpl: async () => {
        fetched = true;
        return new Response(null, { status: 200 });
      },
    });
    const result = await forwardOrLocal(
      { ...notification, forwarded: true },
      "studio",
      "laptop",
      deps,
    );
    expect(result).toBe(false);
    expect(fetched).toBe(false);
  });
});
