import { describe, expect, it, mock, beforeEach } from "bun:test";
import os from "node:os";
import { resetAgentIdCache } from "@nexus/core";
import { upsertSelfInRegistry } from "./agent-registry";

describe("upsertSelfInRegistry", () => {
  beforeEach(() => {
    // Ensure getAgentId() re-evaluates for each test so prior runs don't
    // leak a cached identity into this suite. Also point NEXUS_CONFIG_DIR
    // at a guaranteed-nonexistent path so the helper deterministically
    // falls back to os.hostname() regardless of the developer's own
    // ~/.config/nexus/agents.toml.
    resetAgentIdCache();
    process.env.NEXUS_CONFIG_DIR = "/tmp/nexus-nonexistent-for-test";
  });

  it("calls db.insert with the resolved agent identity as id", async () => {
    // Track what values were passed to .values()
    let capturedValues: Record<string, unknown> | null = null;
    let capturedConflictSet: Record<string, unknown> | null = null;

    // Create a chainable mock that captures insert values and conflict set
    const onConflictDoUpdate = mock(async (opts: { set: Record<string, unknown> }) => {
      capturedConflictSet = opts.set;
    });
    const valuesMock = mock((vals: Record<string, unknown>) => {
      capturedValues = vals;
      return { onConflictDoUpdate };
    });
    const insertMock = mock((_table?: unknown) => ({ values: valuesMock }));

    const mockDb = { insert: insertMock } as unknown as import("@nexus/db").Db;

    await upsertSelfInRegistry(mockDb);

    expect(insertMock).toHaveBeenCalledTimes(1);
    expect(capturedValues).not.toBeNull();
    expect(capturedValues!.id).toBe(os.hostname());
    expect(capturedValues!.name).toBe(os.hostname());
    expect(capturedValues!.enabled).toBe(true);
    expect(capturedValues!.lastSeen).toBeInstanceOf(Date);
    // port should default to 7400 (no NEXUS_PORT env set in test)
    expect(capturedValues!.port).toBe(7400);
  });

  it("does NOT include projectsDir or name in the onConflictDoUpdate set", async () => {
    let conflictSet: Record<string, unknown> | null = null;

    const onConflictDoUpdate = mock(async (opts: { set: Record<string, unknown> }) => {
      conflictSet = opts.set;
    });
    const mockDb = {
      insert: mock(() => ({
        values: mock(() => ({ onConflictDoUpdate })),
      })),
    } as unknown as import("@nexus/db").Db;

    await upsertSelfInRegistry(mockDb);

    expect(conflictSet).not.toBeNull();
    expect(conflictSet).toHaveProperty("host");
    expect(conflictSet).toHaveProperty("port");
    expect(conflictSet).toHaveProperty("lastSeen");
    // projectsDir and name must NOT be in the conflict update set
    expect(conflictSet).not.toHaveProperty("projectsDir");
    expect(conflictSet).not.toHaveProperty("name");
  });
});
