import { describe, expect, it, mock } from "bun:test";
import type { Db } from "@nexus/db";
import { upsertProjectLocations } from "./project-registry";
import type { ProjectToUpsert } from "./project-registry";

// ── Mock helpers ──────────────────────────────────────────────────────────────

/**
 * Build a mock Db that tracks insert/select/update calls.
 *
 * select() calls are answered in order via `selectResponses`. Each response is
 * an array of rows (simulating `.limit(n)` returning that array).
 *
 * insert() calls return a chainable mock that records .values() args and
 * exposes .onConflictDoNothing() and .onConflictDoUpdate().
 *
 * update() calls return a chainable mock that records .set() args.
 */
interface MockDb {
  db: Db;
  insertCalls: Array<{ table: unknown; values: Record<string, unknown> }>;
  onConflictDoNothingCalls: Array<{ target: unknown }>;
  onConflictDoUpdateCalls: Array<{ target: unknown; set: Record<string, unknown> }>;
  updateCalls: Array<{ set: Record<string, unknown> }>;
}

function makeMockDb(selectResponses: unknown[][]): MockDb {
  const insertCalls: Array<{ table: unknown; values: Record<string, unknown> }> = [];
  const onConflictDoNothingCalls: Array<{ target: unknown }> = [];
  const onConflictDoUpdateCalls: Array<{ target: unknown; set: Record<string, unknown> }> = [];
  const updateCalls: Array<{ set: Record<string, unknown> }> = [];

  let selectCallIndex = 0;

  const insert = mock((table: unknown) => {
    const values = mock((vals: Record<string, unknown>) => {
      insertCalls.push({ table, values: vals });
      const onConflictDoNothing = mock((opts?: { target?: unknown }) => {
        onConflictDoNothingCalls.push({ target: opts?.target });
        return Promise.resolve();
      });
      const onConflictDoUpdate = mock((opts: { target: unknown; set: Record<string, unknown> }) => {
        onConflictDoUpdateCalls.push({ target: opts.target, set: opts.set });
        return Promise.resolve();
      });
      return { onConflictDoNothing, onConflictDoUpdate };
    });
    return { values };
  });

  const select = mock((_fields?: unknown) => {
    const responseIndex = selectCallIndex++;
    const rows = selectResponses[responseIndex] ?? [];
    // where() must be both directly awaitable (for sweep: await db.select().from().where())
    // and support .limit() (for per-project selects: await db.select().from().where().limit(1))
    const whereResult = Object.assign(Promise.resolve(rows), {
      limit: mock((_n?: number) => Promise.resolve(rows)),
    });
    return {
      from: mock((_table?: unknown) => ({
        where: mock((_condition?: unknown) => whereResult),
      })),
    };
  });

  const update = mock((_table?: unknown) => {
    const set = mock((vals: Record<string, unknown>) => {
      updateCalls.push({ set: vals });
      return {
        where: mock((_condition?: unknown) => Promise.resolve()),
      };
    });
    return { set };
  });

  const db = { insert, select, update } as unknown as Db;
  return { db, insertCalls, onConflictDoNothingCalls, onConflictDoUpdateCalls, updateCalls };
}

// ── Test data ─────────────────────────────────────────────────────────────────

const FAKE_PROJECT_ID = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";

function makeProject(overrides: Partial<ProjectToUpsert> = {}): ProjectToUpsert {
  return {
    name: "nx",
    path: "/home/leo/dev/nx",
    activeSessions: 0,
    totalSessions: 0,
    ...overrides,
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("upsertProjectLocations", () => {
  // ── Test 3: empty array early-return ───────────────────────────────────────

  describe("empty discovered array", () => {
    it("returns without calling any DB operations", async () => {
      const insertMock = mock((_table?: unknown) => ({ values: mock(() => ({})) }));
      const selectMock = mock((_fields?: unknown) => ({ from: mock(() => ({})) }));
      const updateMock = mock((_table?: unknown) => ({ set: mock(() => ({})) }));

      const db = { insert: insertMock, select: selectMock, update: updateMock } as unknown as Db;

      await upsertProjectLocations(db, "homelab", []);

      expect(insertMock).not.toHaveBeenCalled();
      expect(selectMock).not.toHaveBeenCalled();
      expect(updateMock).not.toHaveBeenCalled();
    });
  });

  // ── Test 1: first discovery creates canonical project row ──────────────────

  describe("first discovery", () => {
    it("inserts a project row with onConflictDoNothing and a location row with onConflictDoUpdate", async () => {
      // select responses in call order:
      // [0] = select({id}).from(projects).where(eq name)  → [{id}]
      // [1] = select({primaryAgentId}).from(projects).where(eq id) → [{primaryAgentId:"homelab"}]
      // [2] = select({id}).from(projects).where(inArray names) → [{id}] (mark-missing sweep)
      const { db, insertCalls, onConflictDoNothingCalls, onConflictDoUpdateCalls } = makeMockDb([
        [{ id: FAKE_PROJECT_ID }],
        [{ primaryAgentId: "homelab" }],
        [{ id: FAKE_PROJECT_ID }],
      ]);

      const project = makeProject();

      await upsertProjectLocations(db, "homelab", [project]);

      // Two insert calls: one for projects, one for projectLocations
      expect(insertCalls).toHaveLength(2);

      // First insert: projects table — values contain name + primaryAgentId
      const projectInsert = insertCalls[0]!;
      expect(projectInsert.values.name).toBe("nx");
      expect(projectInsert.values.primaryAgentId).toBe("homelab");
      expect(projectInsert.values.status).toBe("active");

      // onConflictDoNothing was called for the projects insert
      expect(onConflictDoNothingCalls).toHaveLength(1);

      // Second insert: projectLocations table — values contain path + agentId + projectId
      const locationInsert = insertCalls[1]!;
      expect(locationInsert.values.agentId).toBe("homelab");
      expect(locationInsert.values.path).toBe("/home/leo/dev/nx");
      expect(locationInsert.values.projectId).toBe(FAKE_PROJECT_ID);
      expect(locationInsert.values.status).toBe("active");
      expect(locationInsert.values.activeSessions).toBe(0);
      expect(locationInsert.values.totalSessions).toBe(0);

      // onConflictDoUpdate was called for the location insert
      expect(onConflictDoUpdateCalls).toHaveLength(1);
      const conflictSet = onConflictDoUpdateCalls[0]!.set;
      expect(conflictSet).toHaveProperty("path");
      expect(conflictSet).toHaveProperty("activeSessions");
      expect(conflictSet).toHaveProperty("totalSessions");
      expect(conflictSet).toHaveProperty("status");
      expect(conflictSet).toHaveProperty("lastDiscoveredAt");
    });

    it("sets priority to 1 when the inserting agent is the primary", async () => {
      const { db, insertCalls } = makeMockDb([
        [{ id: FAKE_PROJECT_ID }],
        [{ primaryAgentId: "homelab" }],
        [{ id: FAKE_PROJECT_ID }],
      ]);

      await upsertProjectLocations(db, "homelab", [makeProject()]);

      const locationInsert = insertCalls[1]!;
      expect(locationInsert.values.priority).toBe(1);
    });

    it("sets priority to 999 when the inserting agent is NOT the primary", async () => {
      // primaryAgentId is "homelab" but we're inserting as "mac"
      const { db, insertCalls } = makeMockDb([
        [{ id: FAKE_PROJECT_ID }],
        [{ primaryAgentId: "homelab" }],
        [{ id: FAKE_PROJECT_ID }],
      ]);

      await upsertProjectLocations(db, "mac", [makeProject({ path: "/Users/leo/dev/nx" })]);

      const locationInsert = insertCalls[1]!;
      expect(locationInsert.values.priority).toBe(999);
    });
  });

  // ── Test 2: second agent adds location without overwriting primary ──────────

  describe("second agent adds a location", () => {
    it("does not change primaryAgentId on conflict (onConflictDoNothing)", async () => {
      // Simulate two sequential calls: first by "homelab", then by "mac"
      // We can't easily verify the DB state between calls without a real DB,
      // so we verify the DB operations each agent performs.

      // --- homelab call ---
      const homelabDb = makeMockDb([
        [{ id: FAKE_PROJECT_ID }],
        [{ primaryAgentId: "homelab" }],
        [{ id: FAKE_PROJECT_ID }],
      ]);

      await upsertProjectLocations(homelabDb.db, "homelab", [makeProject()]);

      // projects insert used onConflictDoNothing (not doUpdate) — so it won't
      // overwrite primaryAgentId if the row already exists
      expect(homelabDb.onConflictDoNothingCalls).toHaveLength(1);
      expect(homelabDb.onConflictDoUpdateCalls).toHaveLength(1);

      // homelab's location insert has priority=1 (it is the primary)
      const homelabLocationInsert = homelabDb.insertCalls[1]!;
      expect(homelabLocationInsert.values.priority).toBe(1);
      expect(homelabLocationInsert.values.agentId).toBe("homelab");

      // --- mac call (second agent discovers the same project) ---
      // primaryAgentId was set by homelab first, so select returns "homelab"
      const macDb = makeMockDb([
        [{ id: FAKE_PROJECT_ID }],        // select by name → same project id
        [{ primaryAgentId: "homelab" }],  // select primaryAgentId → still "homelab"
        [{ id: FAKE_PROJECT_ID }],        // mark-missing sweep
      ]);

      await upsertProjectLocations(macDb.db, "mac", [
        makeProject({ path: "/Users/leo/dev/nx" }),
      ]);

      // mac also uses onConflictDoNothing for the projects table insert —
      // this is what prevents "mac" from overwriting primaryAgentId
      expect(macDb.onConflictDoNothingCalls).toHaveLength(1);

      // mac's location insert is a separate row (different agentId)
      expect(macDb.insertCalls).toHaveLength(2);
      const macLocationInsert = macDb.insertCalls[1]!;
      expect(macLocationInsert.values.agentId).toBe("mac");
      expect(macLocationInsert.values.path).toBe("/Users/leo/dev/nx");
      expect(macLocationInsert.values.projectId).toBe(FAKE_PROJECT_ID);

      // mac's priority is 999 because primaryAgentId is "homelab"
      expect(macLocationInsert.values.priority).toBe(999);

      // mac's location upsert uses onConflictDoUpdate (updates on re-scan)
      expect(macDb.onConflictDoUpdateCalls).toHaveLength(1);
    });
  });

  // ── Bonus: mark-missing sweep ─────────────────────────────────────────────

  describe("mark-missing sweep", () => {
    it("calls update to mark locations as missing after processing discovered projects", async () => {
      const { db, updateCalls } = makeMockDb([
        [{ id: FAKE_PROJECT_ID }],
        [{ primaryAgentId: "homelab" }],
        [{ id: FAKE_PROJECT_ID }],
      ]);

      await upsertProjectLocations(db, "homelab", [makeProject()]);

      // update() was called to sweep missing locations
      expect(updateCalls).toHaveLength(1);
      expect(updateCalls[0]!.set).toEqual({ status: "missing" });
    });

    it("skips the project-not-found case gracefully (no location insert)", async () => {
      // select by name returns empty — project not found after insert
      const { db, insertCalls } = makeMockDb([
        [], // select by name → no rows (project not found)
        [{ id: FAKE_PROJECT_ID }], // mark-missing sweep (inArray select)
      ]);

      await upsertProjectLocations(db, "homelab", [makeProject()]);

      // Only one insert (projects), no location insert because project lookup failed
      expect(insertCalls).toHaveLength(1);
      expect(insertCalls[0]!.values.name).toBe("nx");
    });
  });
});
