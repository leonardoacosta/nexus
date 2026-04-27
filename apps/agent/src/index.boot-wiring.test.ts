/**
 * Manifest tests for `apps/agent/src/index.ts` boot wiring
 * (apply-4-findings task 2.11).
 *
 * `index.ts` is a top-level-await entry point that opens the database,
 * binds Bun.serve, starts the watcher bridge, and so on. Importing it in a
 * test would actually boot the agent — far too heavy and side-effecty.
 *
 * Instead, this file is a lightweight regression net: it reads `index.ts`
 * as text and asserts that the peer-connector mount lines are present.
 * It will NOT catch bugs in HOW the connector is mounted — that surface is
 * covered by `services/peer-connector.test.ts` for the connector's own
 * logic — but it WILL catch outright removal of the mount block, which
 * was the regression that motivated task 2.10.
 *
 * Run:
 *   cd apps/agent && bun test src/index.boot-wiring.test.ts
 */

import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const INDEX_PATH = join(import.meta.dir, "index.ts");
const indexSrc = readFileSync(INDEX_PATH, "utf8");

describe("index.ts — peer connector boot wiring", () => {
  it("imports startPeerConnector from the services module", () => {
    expect(indexSrc).toMatch(
      /import\s*\{[^}]*\bstartPeerConnector\b[^}]*\}\s*from\s*["']\.\/services\/peer-connector["']/,
    );
  });

  it("imports the PeerConnectorService type for the local handle", () => {
    // Locks in that the boot block keeps a typed handle so `peerConnector?.stop()`
    // in shutdown() type-checks.
    expect(indexSrc).toContain("PeerConnectorService");
  });

  it("invokes startPeerConnector() during boot", () => {
    // Match the await call regardless of surrounding whitespace / line breaks.
    expect(indexSrc).toMatch(/await\s+startPeerConnector\s*\(/);
  });

  it("wraps the boot call in try/catch with a warn-level fallback (non-fatal)", () => {
    // Failure to start the connector MUST NOT crash the agent — task 2.10
    // explicitly requires logging at warn, not fatal.
    const startIdx = indexSrc.indexOf("startPeerConnector");
    expect(startIdx).toBeGreaterThan(-1);

    // Find the surrounding try { … } catch (err) { logger.warn … } block.
    // We assert that there is a `logger.warn` call within ~20 lines after
    // the startPeerConnector reference — far cheaper than parsing the AST,
    // and tight enough to fail if someone replaces .warn with .error or
    // removes the catch entirely.
    const tail = indexSrc.slice(startIdx, startIdx + 1500);
    expect(tail).toContain("catch");
    expect(tail).toMatch(/logger\.warn\s*\(/);
  });

  it("invokes peerConnector?.stop() during graceful shutdown", () => {
    // Mirrors the cron / spec-watcher / socket-server shutdown pattern.
    expect(indexSrc).toMatch(/peerConnector\?\.stop\s*\(\s*\)/);
  });
});
