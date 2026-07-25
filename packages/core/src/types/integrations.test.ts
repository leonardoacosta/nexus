/**
 * `harden-kokoro-baseurl` — schema + host-guard unit tests.
 *
 * Covers the seven cases from the proposal's Testing section plus the raw
 * `isForbiddenTtsEndpointHost` helper directly (no HTTP involved).
 */

import { describe, test, expect } from "bun:test";
import { integrationMetadataSchemas, isForbiddenTtsEndpointHost } from "./integrations";

describe("isForbiddenTtsEndpointHost", () => {
  test("rejects localhost", () => {
    expect(isForbiddenTtsEndpointHost("localhost")).toBe(true);
  });

  test("rejects 127.0.0.1", () => {
    expect(isForbiddenTtsEndpointHost("127.0.0.1")).toBe(true);
  });

  test("rejects ::1", () => {
    expect(isForbiddenTtsEndpointHost("::1")).toBe(true);
  });

  test("rejects bracketed ::1", () => {
    expect(isForbiddenTtsEndpointHost("[::1]")).toBe(true);
  });

  test("rejects link-local 169.254.x.x", () => {
    expect(isForbiddenTtsEndpointHost("169.254.169.254")).toBe(true);
  });

  test("rejects link-local fe80::", () => {
    expect(isForbiddenTtsEndpointHost("fe80::1")).toBe(true);
  });

  test("is case-insensitive", () => {
    expect(isForbiddenTtsEndpointHost("LOCALHOST")).toBe(true);
  });

  test("allows RFC1918 host", () => {
    expect(isForbiddenTtsEndpointHost("192.168.1.10")).toBe(false);
  });

  test("allows tailnet (100.64.0.0/10) host", () => {
    expect(isForbiddenTtsEndpointHost("100.73.182.4")).toBe(false);
  });

  test("allows a plausible LAN hostname", () => {
    expect(isForbiddenTtsEndpointHost("kokoro.lan")).toBe(false);
  });
});

describe("integrationMetadataSchemas.kokoro", () => {
  const schema = integrationMetadataSchemas.kokoro;

  test("accepts a LAN hostname baseUrl", () => {
    const result = schema.safeParse({ baseUrl: "https://kokoro.lan:8880" });
    expect(result.success).toBe(true);
  });

  test("accepts a tailnet IP baseUrl", () => {
    const result = schema.safeParse({ baseUrl: "http://100.73.182.4:8880" });
    expect(result.success).toBe(true);
  });

  test("rejects loopback IPv4 baseUrl", () => {
    const result = schema.safeParse({ baseUrl: "http://127.0.0.1:8880" });
    expect(result.success).toBe(false);
  });

  test("rejects localhost baseUrl", () => {
    const result = schema.safeParse({ baseUrl: "http://localhost:8880" });
    expect(result.success).toBe(false);
  });

  test("rejects link-local metadata-endpoint baseUrl", () => {
    const result = schema.safeParse({ baseUrl: "http://169.254.169.254/" });
    expect(result.success).toBe(false);
  });

  test("rejects a non-http(s) scheme", () => {
    const result = schema.safeParse({ baseUrl: "ftp://x/" });
    expect(result.success).toBe(false);
  });

  test("rejects bracketed loopback IPv6 baseUrl", () => {
    const result = schema.safeParse({ baseUrl: "https://[::1]/" });
    expect(result.success).toBe(false);
  });

  test("still accepts an optional defaultVoice alongside a valid baseUrl", () => {
    const result = schema.safeParse({
      baseUrl: "https://kokoro.lan:8880",
      defaultVoice: "af_bella",
    });
    expect(result.success).toBe(true);
  });
});
