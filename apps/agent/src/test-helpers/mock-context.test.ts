/**
 * Tests for mock AppContext factory.
 *
 * Verifies the mock context can be created, used, and torn down without
 * errors — proving it's a viable replacement for direct singleton imports
 * in test files.
 */

import { describe, test, expect, afterEach } from "bun:test";
import { createMockContext, teardownMockContext } from "./mock-context";
import type { AppContext } from "../context";

let ctx: AppContext;

afterEach(() => {
  if (ctx) teardownMockContext(ctx);
});

describe("createMockContext", () => {
  test("creates a valid AppContext with all required fields", () => {
    ctx = createMockContext();

    expect(ctx.db).toBeDefined();
    expect(ctx.sessionManager).toBeDefined();
    expect(ctx.lifecycleBus).toBeDefined();
    expect(ctx.commandState).toBeDefined();
    expect(ctx.notificationDedup).toBeDefined();
    expect(ctx.encryptionKey).toBeDefined();
    expect(typeof ctx.prerotateThreshold).toBe("number");
  });

  test("session manager works with watcher events", () => {
    ctx = createMockContext();

    ctx.sessionManager.handleWatcherEvent({
      type: "session_start",
      session_id: "test-sess-1",
      project: "test-project",
      path: "/tmp/test",
    });

    const session = ctx.sessionManager.getById("test-sess-1");
    expect(session).not.toBeNull();
    expect(session!.status).toBe("active");
    expect(session!.project).toBe("test-project");
  });

  test("lifecycle bus emits and receives events", () => {
    ctx = createMockContext();

    let received = false;
    ctx.lifecycleBus.on("SessionStarted", () => {
      received = true;
    });

    ctx.lifecycleBus.emit("SessionStarted", {
      sessionId: "test-1",
      project: "test",
    });

    expect(received).toBe(true);
  });

  test("command state maps are empty and bounded", () => {
    ctx = createMockContext();

    expect(ctx.commandState.typeOverrides.size).toBe(0);
    expect(ctx.commandState.projectRules.size).toBe(0);
    expect(ctx.commandState.currentMode).toBe("full");
    expect(ctx.commandState.notificationHistory).toHaveLength(0);
  });

  test("notification dedup map is empty and functional", () => {
    ctx = createMockContext();

    expect(ctx.notificationDedup.size).toBe(0);

    const future = Date.now() + 60_000;
    ctx.notificationDedup.set("test-key", future);
    expect(ctx.notificationDedup.has("test-key")).toBe(true);
  });

  test("accepts custom options", () => {
    const customKey = Buffer.alloc(32, 0xff);
    ctx = createMockContext({
      encryptionKey: customKey,
      prerotateThreshold: 50,
      maxHistory: 10,
    });

    expect(ctx.encryptionKey).toBe(customKey);
    expect(ctx.prerotateThreshold).toBe(50);
    expect(ctx.commandState.maxHistory).toBe(10);
  });

  test("multiple contexts are isolated", () => {
    ctx = createMockContext();
    const ctx2 = createMockContext();

    ctx.commandState.typeOverrides.set("type-a", "silent");
    expect(ctx2.commandState.typeOverrides.size).toBe(0);

    ctx.notificationDedup.set("key-a", Date.now() + 60_000);
    expect(ctx2.notificationDedup.size).toBe(0);

    teardownMockContext(ctx2);
  });

  test("teardown stops session manager and clears state", () => {
    ctx = createMockContext();

    ctx.notificationDedup.set("key", Date.now() + 60_000);
    ctx.lifecycleBus.on("SessionStarted", () => {});

    teardownMockContext(ctx);

    expect(ctx.notificationDedup.size).toBe(0);
    // Session manager timer is cleared (no assertion needed — just no errors)
  });
});
