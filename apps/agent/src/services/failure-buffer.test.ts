/**
 * FailureBuffer unit tests.
 *
 * Tests cover add/list/count/clear operations, TTL-based eviction,
 * max capacity (100 entries), and ordering (newest first).
 */

import { describe, it, expect, beforeEach } from "bun:test";
import { FailureBuffer, type FailureEntry } from "./failure-buffer";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeEntry(
  source: string,
  message: string,
  timestamp?: Date,
): FailureEntry {
  return {
    timestamp: timestamp ?? new Date(),
    source,
    message,
  };
}

function makeOldEntry(hoursAgo: number): FailureEntry {
  const ts = new Date(Date.now() - hoursAgo * 3600_000);
  return makeEntry("test", `failure from ${hoursAgo}h ago`, ts);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("FailureBuffer", () => {
  let buffer: FailureBuffer;

  beforeEach(() => {
    buffer = new FailureBuffer();
  });

  // ── Basic CRUD ──────────────────────────────────────────────────────────

  it("starts empty", () => {
    expect(buffer.count()).toBe(0);
    expect(buffer.list()).toEqual([]);
  });

  it("add() increments count", () => {
    buffer.add(makeEntry("test", "failure one"));
    expect(buffer.count()).toBe(1);

    buffer.add(makeEntry("test", "failure two"));
    expect(buffer.count()).toBe(2);
  });

  it("list() returns entries newest first", () => {
    const older = makeEntry("src-a", "first", new Date(Date.now() - 10_000));
    const newer = makeEntry("src-b", "second", new Date());

    buffer.add(older);
    buffer.add(newer);

    const items = buffer.list();
    expect(items).toHaveLength(2);
    expect(items[0]!.source).toBe("src-b"); // newest first
    expect(items[1]!.source).toBe("src-a");
  });

  it("clear() empties the buffer", () => {
    buffer.add(makeEntry("test", "entry"));
    buffer.add(makeEntry("test", "entry2"));
    expect(buffer.count()).toBe(2);

    buffer.clear();
    expect(buffer.count()).toBe(0);
    expect(buffer.list()).toEqual([]);
  });

  it("preserves optional fields (stack, context)", () => {
    const entry: FailureEntry = {
      timestamp: new Date(),
      source: "router",
      message: "connection refused",
      stack: "Error: connection refused\n  at connect()",
      context: { host: "localhost", port: 5432 },
    };

    buffer.add(entry);
    const items = buffer.list();
    expect(items[0]!.stack).toBe("Error: connection refused\n  at connect()");
    expect(items[0]!.context).toEqual({ host: "localhost", port: 5432 });
  });

  // ── TTL eviction ────────────────────────────────────────────────────────

  it("evicts entries older than 24 hours on list()", () => {
    // Add an entry from 25 hours ago.
    buffer.add(makeOldEntry(25));
    // Add a fresh entry.
    buffer.add(makeEntry("test", "fresh"));

    const items = buffer.list();
    expect(items).toHaveLength(1);
    expect(items[0]!.message).toBe("fresh");
  });

  it("evicts entries older than 24 hours on count()", () => {
    buffer.add(makeOldEntry(25));
    buffer.add(makeOldEntry(30));
    buffer.add(makeEntry("test", "recent"));

    expect(buffer.count()).toBe(1);
  });

  it("evicts entries older than 24 hours on add()", () => {
    // Start with old entries.
    buffer.add(makeOldEntry(48));
    buffer.add(makeOldEntry(36));

    // Adding a new entry should trigger eviction of old ones first.
    buffer.add(makeEntry("test", "new"));

    expect(buffer.count()).toBe(1);
    expect(buffer.list()[0]!.message).toBe("new");
  });

  it("keeps entries that are exactly at TTL boundary", () => {
    // Entry from 23 hours ago should survive.
    buffer.add(makeOldEntry(23));
    expect(buffer.count()).toBe(1);
  });

  // ── Max capacity (100) ────────────────────────────────────────────────

  it("caps at 100 entries, evicting oldest", () => {
    // Add 105 entries.
    for (let i = 0; i < 105; i++) {
      buffer.add(
        makeEntry("test", `entry-${i}`, new Date(Date.now() + i)),
      );
    }

    expect(buffer.count()).toBe(100);

    // The first 5 entries (0-4) should have been evicted.
    const items = buffer.list();
    expect(items[items.length - 1]!.message).toBe("entry-5");
    expect(items[0]!.message).toBe("entry-104");
  });

  it("oldest entry is removed when adding at capacity", () => {
    // Fill to capacity.
    for (let i = 0; i < 100; i++) {
      buffer.add(makeEntry("test", `fill-${i}`, new Date(Date.now() + i)));
    }

    expect(buffer.count()).toBe(100);

    // Add one more.
    buffer.add(makeEntry("test", "overflow", new Date(Date.now() + 200)));
    expect(buffer.count()).toBe(100);

    // The oldest (fill-0) should be gone.
    const items = buffer.list();
    const messages = items.map((e) => e.message);
    expect(messages).not.toContain("fill-0");
    expect(messages).toContain("overflow");
  });

  // ── Edge cases ──────────────────────────────────────────────────────────

  it("list() returns a copy (mutations do not affect buffer)", () => {
    buffer.add(makeEntry("test", "original"));
    const items = buffer.list();
    items.pop();

    // Buffer should still have the entry.
    expect(buffer.count()).toBe(1);
  });

  it("handles rapid sequential adds", () => {
    const now = Date.now();
    for (let i = 0; i < 50; i++) {
      buffer.add(makeEntry(`src-${i}`, `msg-${i}`, new Date(now + i)));
    }

    expect(buffer.count()).toBe(50);
    const items = buffer.list();
    // Newest first.
    expect(items[0]!.source).toBe("src-49");
    expect(items[49]!.source).toBe("src-0");
  });
});
