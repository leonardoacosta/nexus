/**
 * /api/health route contract tests — spec: add-dashboard-observability-baseline
 *
 * Verifies:
 *   3.1 — GET returns HTTP 200
 *   3.1 — Body shape matches { status: "ok", version: string, timestamp: string }
 *   3.1 — timestamp is a valid ISO 8601 string
 */

import { vi, describe, it, expect, beforeEach, afterEach } from "vitest";

// Must be hoisted so the factory runs before module imports
const { mockDate } = vi.hoisted(() => ({
  mockDate: new Date("2026-01-15T12:00:00.000Z"),
}));

// Import AFTER any potential vi.mock calls
import { GET } from "./route";

describe("/api/health GET", () => {
  let originalNexusVersion: string | undefined;
  let originalNpmVersion: string | undefined;

  beforeEach(() => {
    originalNexusVersion = process.env.NEXUS_VERSION;
    originalNpmVersion = process.env.npm_package_version;
    vi.useFakeTimers();
    vi.setSystemTime(mockDate);
  });

  afterEach(() => {
    if (originalNexusVersion === undefined) {
      delete process.env.NEXUS_VERSION;
    } else {
      process.env.NEXUS_VERSION = originalNexusVersion;
    }
    if (originalNpmVersion === undefined) {
      delete process.env.npm_package_version;
    } else {
      process.env.npm_package_version = originalNpmVersion;
    }
    vi.useRealTimers();
  });

  it("returns HTTP 200", async () => {
    const response = await GET();
    expect(response.status).toBe(200);
  });

  it("returns { status: 'ok' }", async () => {
    const response = await GET();
    const body = await response.json();
    expect(body.status).toBe("ok");
  });

  it("returns a version string", async () => {
    process.env.NEXUS_VERSION = "1.2.3";
    const response = await GET();
    const body = await response.json();
    expect(typeof body.version).toBe("string");
    expect(body.version).toBe("1.2.3");
  });

  it("returns a timestamp string", async () => {
    const response = await GET();
    const body = await response.json();
    expect(typeof body.timestamp).toBe("string");
  });

  it("timestamp parses as a valid ISO 8601 date", async () => {
    const response = await GET();
    const body = await response.json();
    const parsed = new Date(body.timestamp);
    expect(parsed.toString()).not.toBe("Invalid Date");
    // ISO 8601 format: ends with 'Z' or has timezone offset
    expect(body.timestamp).toMatch(
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/,
    );
  });

  it("timestamp reflects current time", async () => {
    const response = await GET();
    const body = await response.json();
    expect(body.timestamp).toBe(mockDate.toISOString());
  });

  it("body has exactly the expected shape keys", async () => {
    const response = await GET();
    const body = await response.json();
    expect(Object.keys(body).sort()).toEqual(["status", "timestamp", "version"]);
  });

  it("prefers NEXUS_VERSION over npm_package_version", async () => {
    process.env.NEXUS_VERSION = "2.0.0";
    process.env.npm_package_version = "0.1.0";
    const response = await GET();
    const body = await response.json();
    expect(body.version).toBe("2.0.0");
  });

  it("falls back to npm_package_version when NEXUS_VERSION is unset", async () => {
    delete process.env.NEXUS_VERSION;
    process.env.npm_package_version = "0.1.0";
    const response = await GET();
    const body = await response.json();
    expect(body.version).toBe("0.1.0");
  });

  it("returns 'unknown' when both version env vars are unset", async () => {
    delete process.env.NEXUS_VERSION;
    delete process.env.npm_package_version;
    const response = await GET();
    const body = await response.json();
    expect(body.version).toBe("unknown");
  });

  it("completes within 50ms", async () => {
    const start = Date.now();
    await GET();
    const elapsed = Date.now() - start;
    expect(elapsed).toBeLessThan(50);
  });
});
