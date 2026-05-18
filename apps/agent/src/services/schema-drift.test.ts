/**
 * Tests for `services/schema-drift.ts`.
 *
 * Spec: openspec/changes/add-schema-drift-detector
 *
 * Covers:
 *   1. Fingerprint determinism — same top-level keys → same fingerprint.
 *   2. Fingerprint sensitivity — different top-level keys → different fingerprints.
 *   3. Rate-limit window — only one `HookSchemaDrift` emit per event_type per hour.
 *   4. New-pair emission — first observation of a (event_type, fingerprint) pair
 *      triggers the lifecycle event.
 */

import { describe, test, expect, beforeEach } from "bun:test";
import {
  fingerprintPayload,
  inspectAndEmitDrift,
  _resetSchemaDriftRateLimitForTest,
  DRIFT_RATE_LIMIT_MS,
} from "./schema-drift";
import { lifecycleBus, type LifecycleEnvelope } from "./lifecycle-bus";

// ---------------------------------------------------------------------------
// Stub Db — captures the inputs to select/insert/update so we can assert on
// behaviour without standing up Postgres.
// ---------------------------------------------------------------------------

interface SelectCall {
  table: string;
  where?: unknown;
}

function makeStubDb(opts: { existing?: boolean } = {}): {
  db: any; // eslint-disable-line @typescript-eslint/no-explicit-any
  selectCalls: SelectCall[];
  insertCalls: number;
  updateCalls: number;
} {
  let selectCalls: SelectCall[] = [];
  let insertCalls = 0;
  let updateCalls = 0;

  const buildChain = (terminalRows: unknown[]) => {
    const chain: any = {
      from: () => chain,
      where: () => chain,
      limit: async () => terminalRows,
      set: () => chain,
      values: () => chain,
      onConflictDoNothing: () => Promise.resolve(),
    };
    return chain;
  };

  const db = {
    select() {
      selectCalls.push({ table: "hook_schema_fingerprints" });
      // First call returns existing/none based on opts.existing toggle.
      const terminal = opts.existing ? [{ eventType: "x", fingerprint: "y" }] : [];
      return buildChain(terminal);
    },
    insert() {
      insertCalls++;
      return buildChain([]);
    },
    update() {
      updateCalls++;
      return buildChain([]);
    },
  };

  return {
    db,
    get selectCalls() { return selectCalls; },
    get insertCalls() { return insertCalls; },
    get updateCalls() { return updateCalls; },
  } as any; // eslint-disable-line @typescript-eslint/no-explicit-any
}

// ---------------------------------------------------------------------------
// Fingerprint determinism / sensitivity
// ---------------------------------------------------------------------------

describe("fingerprintPayload", () => {
  test("same top-level keys produce the same fingerprint", () => {
    const a = fingerprintPayload({ x: 1, y: "a", z: true });
    const b = fingerprintPayload({ z: false, y: "b", x: 999 });
    expect(a).toBe(b);
  });

  test("key order does not affect fingerprint", () => {
    const a = fingerprintPayload({ alpha: 1, beta: 2, gamma: 3 });
    const b = fingerprintPayload({ gamma: 3, alpha: 1, beta: 2 });
    expect(a).toBe(b);
  });

  test("different top-level key sets produce different fingerprints", () => {
    const a = fingerprintPayload({ x: 1, y: 2 });
    const b = fingerprintPayload({ x: 1, y: 2, z: 3 });
    expect(a).not.toBe(b);
  });

  test("non-object payloads collapse to a sentinel fingerprint", () => {
    const a = fingerprintPayload(null);
    const b = fingerprintPayload([1, 2, 3]);
    const c = fingerprintPayload("string");
    const d = fingerprintPayload(42);
    expect(a).toBe(b);
    expect(b).toBe(c);
    expect(c).toBe(d);
  });
});

// ---------------------------------------------------------------------------
// inspectAndEmitDrift — new pair + rate limit
// ---------------------------------------------------------------------------

describe("inspectAndEmitDrift", () => {
  beforeEach(() => {
    _resetSchemaDriftRateLimitForTest();
    lifecycleBus.removeAllListeners();
  });

  test("new (event_type, fingerprint) pair emits HookSchemaDrift", async () => {
    const events: LifecycleEnvelope<"HookSchemaDrift">[] = [];
    lifecycleBus.on("HookSchemaDrift", (env) => events.push(env));

    const stub = makeStubDb({ existing: false });
    await inspectAndEmitDrift(stub.db, "PreToolUse", { tool: "Read" });

    expect(events).toHaveLength(1);
    expect(events[0]!.payload.eventType).toBe("PreToolUse");
    expect(events[0]!.payload.fingerprint).toBeTruthy();
  });

  test("rate-limit suppresses duplicate emits within the window", async () => {
    const events: LifecycleEnvelope<"HookSchemaDrift">[] = [];
    lifecycleBus.on("HookSchemaDrift", (env) => events.push(env));

    const stub = makeStubDb({ existing: false });
    // Two new-pair observations of the same event_type back-to-back.
    await inspectAndEmitDrift(stub.db, "PreToolUse", { tool: "Read" });
    await inspectAndEmitDrift(stub.db, "PreToolUse", { tool: "Read" });

    // Both DB inserts happen (idempotent via onConflictDoNothing), but the
    // lifecycle emit is rate-limited to one per event_type per hour.
    expect(events).toHaveLength(1);
  });

  test("different event_types each get their own emit", async () => {
    const events: LifecycleEnvelope<"HookSchemaDrift">[] = [];
    lifecycleBus.on("HookSchemaDrift", (env) => events.push(env));

    const stub = makeStubDb({ existing: false });
    await inspectAndEmitDrift(stub.db, "PreToolUse", { tool: "Read" });
    await inspectAndEmitDrift(stub.db, "PostToolUse", { tool: "Read" });

    expect(events).toHaveLength(2);
    expect(events[0]!.payload.eventType).toBe("PreToolUse");
    expect(events[1]!.payload.eventType).toBe("PostToolUse");
  });

  test("DRIFT_RATE_LIMIT_MS is one hour", () => {
    expect(DRIFT_RATE_LIMIT_MS).toBe(60 * 60 * 1000);
  });
});
