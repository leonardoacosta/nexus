import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, readdirSync, readFileSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import type { WatcherEvent } from "@nexus/core";
import { detectProject, resolveSessionId } from "./detect";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

/** Temporary events directory for test isolation. */
const TEST_EVENTS_DIR = join(tmpdir(), `nexus-register-test-${process.pid}`);

/**
 * Run nexus-register as a subprocess in the given CWD, writing events to
 * a temp directory via HOME override so ~/.config/nexus/events/ resolves there.
 */
async function runRegister(
  command: string,
  cwd: string,
  env: Record<string, string> = {},
): Promise<{ exitCode: number; stderr: string }> {
  // Create a fake home so events land in our test dir
  const fakeHome = join(TEST_EVENTS_DIR, "home");
  const fakeEventsDir = join(fakeHome, ".config", "nexus", "events");
  mkdirSync(fakeEventsDir, { recursive: true });

  const proc = Bun.spawn(
    ["bun", "run", join(import.meta.dir, "index.ts"), command],
    {
      cwd,
      env: {
        ...process.env,
        HOME: fakeHome,
        ...env,
      },
      stdout: "pipe",
      stderr: "pipe",
    },
  );

  const exitCode = await proc.exited;
  const stderr = await new Response(proc.stderr).text();

  return { exitCode, stderr };
}

/** Read all event files from the fake events dir. */
function readEvents(): WatcherEvent[] {
  const fakeEventsDir = join(TEST_EVENTS_DIR, "home", ".config", "nexus", "events");
  try {
    const files = readdirSync(fakeEventsDir).filter((f) => f.endsWith(".json"));
    return files.map((f) => {
      const content = readFileSync(join(fakeEventsDir, f), "utf-8");
      return JSON.parse(content.trim()) as WatcherEvent;
    });
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

beforeEach(() => {
  mkdirSync(TEST_EVENTS_DIR, { recursive: true });
});

afterEach(() => {
  rmSync(TEST_EVENTS_DIR, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// [6.1] start creates valid event file
// ---------------------------------------------------------------------------

describe("nexus-register start", () => {
  test("creates a session_start event file", async () => {
    const { exitCode } = await runRegister("start", "/tmp", {
      CLAUDE_SESSION_ID: "test-session-001",
    });

    expect(exitCode).toBe(0);

    const events = readEvents();
    expect(events.length).toBe(1);

    const event = events[0]!;
    expect(event.type).toBe("session_start");
    expect(event.session_id).toBe("test-session-001");

    // Type narrowing for session_start fields
    if (event.type === "session_start") {
      expect(event.project).toBe("tmp");
      expect(event.path).toBe("/tmp");
    }
  });
});

// ---------------------------------------------------------------------------
// [6.2] stop creates valid event file with correct session ID
// ---------------------------------------------------------------------------

describe("nexus-register stop", () => {
  test("creates a session_end event file with correct session ID", async () => {
    const { exitCode } = await runRegister("stop", "/tmp", {
      CLAUDE_SESSION_ID: "test-session-002",
    });

    expect(exitCode).toBe(0);

    const events = readEvents();
    expect(events.length).toBe(1);

    const event = events[0]!;
    expect(event.type).toBe("session_end");
    expect(event.session_id).toBe("test-session-002");
  });
});

// ---------------------------------------------------------------------------
// [6.3] heartbeat creates update event
// ---------------------------------------------------------------------------

describe("nexus-register heartbeat", () => {
  test("creates a session_update event file", async () => {
    const { exitCode } = await runRegister("heartbeat", "/tmp", {
      CLAUDE_SESSION_ID: "test-session-003",
    });

    expect(exitCode).toBe(0);

    const events = readEvents();
    expect(events.length).toBe(1);

    const event = events[0]!;
    expect(event.type).toBe("session_update");
    expect(event.session_id).toBe("test-session-003");

    if (event.type === "session_update") {
      expect(event.timestamp).toBeTruthy();
      // Timestamp should be a valid ISO 8601 string
      expect(new Date(event.timestamp).toISOString()).toBe(event.timestamp);
    }
  });
});

// ---------------------------------------------------------------------------
// [6.4] project detection
// ---------------------------------------------------------------------------

describe("project detection", () => {
  test("extracts project code from CWD path", () => {
    expect(detectProject("/home/user/dev/co")).toBe("co");
    expect(detectProject("/home/user/dev/nx")).toBe("nx");
    expect(detectProject("/tmp")).toBe("tmp");
  });

  test("handles trailing slashes", () => {
    expect(detectProject("/home/user/dev/co/")).toBe("co");
  });

  test("resolveSessionId uses CLAUDE_SESSION_ID env var", () => {
    const original = process.env.CLAUDE_SESSION_ID;
    try {
      process.env.CLAUDE_SESSION_ID = "env-session-123";
      expect(resolveSessionId()).toBe("env-session-123");
    } finally {
      if (original === undefined) {
        delete process.env.CLAUDE_SESSION_ID;
      } else {
        process.env.CLAUDE_SESSION_ID = original;
      }
    }
  });

  test("resolveSessionId generates stable fallback without env var", () => {
    const original = process.env.CLAUDE_SESSION_ID;
    try {
      delete process.env.CLAUDE_SESSION_ID;
      const id1 = resolveSessionId();
      const id2 = resolveSessionId();
      expect(id1).toBe(id2); // stable
      expect(id1.startsWith("gen-")).toBe(true);
    } finally {
      if (original !== undefined) {
        process.env.CLAUDE_SESSION_ID = original;
      }
    }
  });
});

// ---------------------------------------------------------------------------
// Invalid usage
// ---------------------------------------------------------------------------

describe("invalid usage", () => {
  test("exits with error on unknown command", async () => {
    const { exitCode, stderr } = await runRegister("unknown", "/tmp", {
      CLAUDE_SESSION_ID: "test-session",
    });

    expect(exitCode).toBe(1);
    expect(stderr).toContain("Usage:");
  });

  test("exits with error when no command given", async () => {
    // Pass empty string to trigger no-command path
    const fakeHome = join(TEST_EVENTS_DIR, "home");
    mkdirSync(join(fakeHome, ".config", "nexus", "events"), { recursive: true });

    const proc = Bun.spawn(
      ["bun", "run", join(import.meta.dir, "index.ts")],
      {
        cwd: "/tmp",
        env: { ...process.env, HOME: fakeHome },
        stdout: "pipe",
        stderr: "pipe",
      },
    );

    const exitCode = await proc.exited;
    expect(exitCode).toBe(1);
  });
});
