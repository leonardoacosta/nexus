import { Database } from "bun:sqlite";
import { describe, expect, it, beforeEach, afterAll } from "bun:test";
import { join } from "node:path";
import { startServer } from "../server";
import { runMigrations } from "../db/migrate";
import { insertSession } from "../db/sessions";
import type { SessionRow } from "../db/sessions";
import { clearSessionsCache } from "./sessions";
import { clearProjectsCache } from "./projects";

// ── Test helpers ───────────────────────────────────────────────────────────

const MIGRATIONS_DIR = join(import.meta.dir, "../../migrations");

function setupDb(): Database {
  const db = new Database(":memory:");
  db.exec("PRAGMA journal_mode = WAL");
  runMigrations(db, MIGRATIONS_DIR);
  return db;
}

function makeSession(overrides: Partial<SessionRow> = {}): SessionRow {
  return {
    id: "sess-001",
    project: "nexus",
    machine: "dev-1",
    status: "active",
    started_at: new Date().toISOString(),
    last_activity: new Date().toISOString(),
    ended_at: null,
    pid: 1234,
    cwd: "/home/user/dev/nx",
    ...overrides,
  };
}

// ── Setup: fresh DB + server per describe block ────────────────────────────

let db: Database;
let baseUrl: string;
let server: ReturnType<typeof startServer>;

beforeEach(() => {
  // Close previous server/db if any
  if (server) server.stop();
  if (db) db.close();

  // Clear caches between tests
  clearSessionsCache();
  clearProjectsCache();

  db = setupDb();
  server = startServer(0, db);
  baseUrl = `http://localhost:${server.port}`;
});

afterAll(() => {
  if (server) server.stop();
  if (db) db.close();
});

// ── 5.1 GET /sessions returns sessions array ──────────────────────────────

describe("GET /sessions", () => {
  it("returns sessions array", async () => {
    insertSession(db, makeSession({ id: "s1", status: "active" }));
    insertSession(db, makeSession({ id: "s2", status: "idle" }));

    const res = await fetch(`${baseUrl}/sessions`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/json");

    const body = (await res.json()) as SessionRow[];
    expect(Array.isArray(body)).toBe(true);
    expect(body.length).toBe(2);

    const ids = body.map((s) => s.id);
    expect(ids).toContain("s1");
    expect(ids).toContain("s2");
  });

  it("returns empty array when no sessions exist", async () => {
    const res = await fetch(`${baseUrl}/sessions`);
    expect(res.status).toBe(200);

    const body = (await res.json()) as SessionRow[];
    expect(body).toEqual([]);
  });
});

// ── 5.2 GET /sessions?project=co filters correctly ────────────────────────

describe("GET /sessions?project=", () => {
  it("filters by project name", async () => {
    insertSession(db, makeSession({ id: "s1", project: "co", status: "active" }));
    insertSession(db, makeSession({ id: "s2", project: "nx", status: "active" }));
    insertSession(db, makeSession({ id: "s3", project: "co", status: "idle" }));

    const res = await fetch(`${baseUrl}/sessions?project=co`);
    expect(res.status).toBe(200);

    const body = (await res.json()) as SessionRow[];
    expect(body.length).toBe(2);
    expect(body.every((s) => s.project === "co")).toBe(true);
  });

  it("returns empty array for non-matching project", async () => {
    insertSession(db, makeSession({ id: "s1", project: "nx", status: "active" }));

    const res = await fetch(`${baseUrl}/sessions?project=nonexistent`);
    expect(res.status).toBe(200);

    const body = (await res.json()) as SessionRow[];
    expect(body).toEqual([]);
  });
});

// ── 5.3 GET /sessions?status=active filters correctly ─────────────────────

describe("GET /sessions?status=", () => {
  it("filters by status", async () => {
    insertSession(db, makeSession({ id: "s1", status: "active" }));
    insertSession(db, makeSession({ id: "s2", status: "idle" }));
    insertSession(
      db,
      makeSession({ id: "s3", status: "ended", ended_at: new Date().toISOString() }),
    );

    const res = await fetch(`${baseUrl}/sessions?status=active`);
    expect(res.status).toBe(200);

    const body = (await res.json()) as SessionRow[];
    expect(body.length).toBe(1);
    expect(body[0]!.id).toBe("s1");
    expect(body[0]!.status).toBe("active");
  });

  it("combines project and status filters", async () => {
    insertSession(db, makeSession({ id: "s1", project: "co", status: "active" }));
    insertSession(db, makeSession({ id: "s2", project: "co", status: "idle" }));
    insertSession(db, makeSession({ id: "s3", project: "nx", status: "active" }));

    const res = await fetch(`${baseUrl}/sessions?project=co&status=active`);
    expect(res.status).toBe(200);

    const body = (await res.json()) as SessionRow[];
    expect(body.length).toBe(1);
    expect(body[0]!.id).toBe("s1");
  });
});

// ── 5.4 GET /sessions/{id} returns session, 404 for unknown ───────────────

describe("GET /sessions/{id}", () => {
  it("returns a single session by ID", async () => {
    insertSession(db, makeSession({ id: "sess-abc", project: "nx" }));

    const res = await fetch(`${baseUrl}/sessions/sess-abc`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/json");

    const body = (await res.json()) as SessionRow;
    expect(body.id).toBe("sess-abc");
    expect(body.project).toBe("nx");
  });

  it("returns 404 for unknown session ID", async () => {
    const res = await fetch(`${baseUrl}/sessions/does-not-exist`);
    expect(res.status).toBe(404);

    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("session not found");
  });
});

// ── 5.5 GET /projects returns aggregated project data ─────────────────────

describe("GET /projects", () => {
  it("returns aggregated project list", async () => {
    insertSession(
      db,
      makeSession({ id: "s1", project: "co", machine: "dev-1", status: "active" }),
    );
    insertSession(
      db,
      makeSession({ id: "s2", project: "co", machine: "dev-2", status: "idle" }),
    );
    insertSession(
      db,
      makeSession({
        id: "s3",
        project: "co",
        machine: "dev-1",
        status: "ended",
        ended_at: new Date().toISOString(),
      }),
    );
    insertSession(
      db,
      makeSession({ id: "s4", project: "nx", machine: "dev-1", status: "active" }),
    );

    const res = await fetch(`${baseUrl}/projects`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/json");

    const body = (await res.json()) as Array<{
      name: string;
      active_sessions: number;
      total_sessions: number;
      machines: string[];
    }>;

    expect(Array.isArray(body)).toBe(true);
    expect(body.length).toBe(2);

    const co = body.find((p) => p.name === "co");
    expect(co).toBeDefined();
    expect(co!.active_sessions).toBe(2); // active + idle
    expect(co!.total_sessions).toBe(3);
    expect(co!.machines).toEqual(["dev-1", "dev-2"]);

    const nx = body.find((p) => p.name === "nx");
    expect(nx).toBeDefined();
    expect(nx!.active_sessions).toBe(1);
    expect(nx!.total_sessions).toBe(1);
    expect(nx!.machines).toEqual(["dev-1"]);
  });

  it("returns empty array when no sessions exist", async () => {
    const res = await fetch(`${baseUrl}/projects`);
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body).toEqual([]);
  });
});

// ── 5.6 Invalid query params return 400 ───────────────────────────────────

describe("GET /sessions?status=invalid", () => {
  it("returns 400 for invalid status value", async () => {
    const res = await fetch(`${baseUrl}/sessions?status=invalid`);
    expect(res.status).toBe(400);

    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("invalid status filter");
  });

  it("returns 400 for another invalid status value", async () => {
    const res = await fetch(`${baseUrl}/sessions?status=running`);
    expect(res.status).toBe(400);

    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("invalid status filter");
  });
});
