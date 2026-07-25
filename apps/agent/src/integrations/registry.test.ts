/**
 * `harden-kokoro-baseurl` — registry-level guard: a forbidden persisted
 * `baseUrl` (loopback/link-local, or one written before the schema-level
 * guard existed) must never reach `fetch` from `testProbe`/`listVoices`.
 *
 * Stubs `globalThis.fetch` and asserts zero calls — follows the fetch-stub
 * pattern in `apps/agent/src/notifications/channels/tts.test.ts`.
 */

import { describe, test, expect, beforeEach, afterEach, mock } from "bun:test";
import { INTEGRATION_PROVIDERS, TTS_VOICE_PROVIDERS } from "@nexus/core";
import { PROVIDER_DESCRIPTORS } from "./registry";

const kokoro = PROVIDER_DESCRIPTORS.kokoro!;

let originalFetch: typeof globalThis.fetch;
let fetchSpy: ReturnType<typeof mock>;

beforeEach(() => {
  originalFetch = globalThis.fetch;
  fetchSpy = mock(async () => new Response(JSON.stringify({ voices: [] }), { status: 200 }));
  globalThis.fetch = fetchSpy as unknown as typeof globalThis.fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

/**
 * `derive-tts-provider-lists` — membership pins. The provider lists live in
 * three places that no compiler cross-checks (`INTEGRATION_PROVIDERS`,
 * `PROVIDER_DESCRIPTORS`, `TTS_VOICE_PROVIDERS`); these assertions fail loudly
 * when one drifts from the others.
 */
describe("provider registry membership", () => {
  test("every PROVIDER_DESCRIPTORS key is a known INTEGRATION_PROVIDERS id", () => {
    const known = new Set<string>(INTEGRATION_PROVIDERS);
    for (const key of Object.keys(PROVIDER_DESCRIPTORS)) {
      expect(known.has(key)).toBe(true);
    }
  });

  test("every descriptor's `provider` field matches its registry key", () => {
    for (const [key, descriptor] of Object.entries(PROVIDER_DESCRIPTORS)) {
      expect(descriptor.provider).toBe(key);
    }
  });

  test("TTS_VOICE_PROVIDERS is exactly {elevenlabs, kokoro}", () => {
    expect([...TTS_VOICE_PROVIDERS].sort()).toEqual(["elevenlabs", "kokoro"]);
  });

  test("every TTS provider except elevenlabs has a descriptor", () => {
    for (const provider of TTS_VOICE_PROVIDERS) {
      if (provider === "elevenlabs") continue;
      expect(PROVIDER_DESCRIPTORS[provider]).toBeDefined();
    }
  });
});

describe("kokoro testProbe — forbidden baseUrl guard", () => {
  test("loopback baseUrl short-circuits without fetching", async () => {
    const result = await kokoro.testProbe("", { baseUrl: "http://127.0.0.1:8880" });
    expect(result).toEqual({ ok: false, statusCode: null });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  test("localhost baseUrl short-circuits without fetching", async () => {
    const result = await kokoro.testProbe("", { baseUrl: "http://localhost:8880" });
    expect(result).toEqual({ ok: false, statusCode: null });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  test("link-local baseUrl short-circuits without fetching", async () => {
    const result = await kokoro.testProbe("", { baseUrl: "http://169.254.169.254/" });
    expect(result).toEqual({ ok: false, statusCode: null });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  test("non-http(s) scheme short-circuits without fetching", async () => {
    const result = await kokoro.testProbe("", { baseUrl: "ftp://127.0.0.1/" });
    expect(result).toEqual({ ok: false, statusCode: null });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  test("allowed baseUrl still fetches", async () => {
    const result = await kokoro.testProbe("", { baseUrl: "http://100.73.182.4:8880" });
    expect(result.ok).toBe(true);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });
});

describe("kokoro listVoices — forbidden baseUrl guard", () => {
  test("loopback baseUrl short-circuits without fetching", async () => {
    const result = await kokoro.listVoices!("", { baseUrl: "http://127.0.0.1:8880" });
    expect(result).toEqual({ ok: false, statusCode: null, voices: [] });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  test("link-local baseUrl short-circuits without fetching", async () => {
    const result = await kokoro.listVoices!("", { baseUrl: "http://169.254.169.254/" });
    expect(result).toEqual({ ok: false, statusCode: null, voices: [] });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  test("allowed baseUrl still fetches and returns voices", async () => {
    const result = await kokoro.listVoices!("", { baseUrl: "http://100.73.182.4:8880" });
    expect(result.ok).toBe(true);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });
});
