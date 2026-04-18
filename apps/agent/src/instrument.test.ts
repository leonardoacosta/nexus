/**
 * instrument.ts release resolution contract tests — spec: add-dashboard-observability-baseline
 *
 * Verifies:
 *   3.3 — NEXUS_VERSION takes precedence over npm_package_version
 *   3.3 — falls back to npm_package_version when NEXUS_VERSION is unset
 *   3.3 — returns undefined when both env vars are unset
 *
 * Uses bun:test — matches the agent package test runtime.
 * Tests the exported resolveRelease() helper directly to avoid Sentry.init
 * side-effects.
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";

// Capture originals so we can restore after each test
let originalNexusVersion: string | undefined;
let originalNpmVersion: string | undefined;

beforeEach(() => {
  originalNexusVersion = process.env.NEXUS_VERSION;
  originalNpmVersion = process.env.npm_package_version;
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
});

describe("resolveRelease", () => {
  test("returns NEXUS_VERSION when both env vars are set", async () => {
    process.env.NEXUS_VERSION = "1.2.3";
    process.env.npm_package_version = "0.1.0";

    // Dynamic import after env mutation so process.env is already set.
    // bun caches modules — use a cache-busting query for isolation.
    const { resolveRelease } = await import(
      `./instrument.ts?v=${Date.now()}-both`
    );

    expect(resolveRelease()).toBe("1.2.3");
  });

  test("returns npm_package_version when NEXUS_VERSION is unset", async () => {
    delete process.env.NEXUS_VERSION;
    process.env.npm_package_version = "0.1.0";

    const { resolveRelease } = await import(
      `./instrument.ts?v=${Date.now()}-npm`
    );

    expect(resolveRelease()).toBe("0.1.0");
  });

  test("returns undefined when both env vars are unset", async () => {
    delete process.env.NEXUS_VERSION;
    delete process.env.npm_package_version;

    const { resolveRelease } = await import(
      `./instrument.ts?v=${Date.now()}-none`
    );

    expect(resolveRelease()).toBeUndefined();
  });
});
