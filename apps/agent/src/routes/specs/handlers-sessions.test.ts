/**
 * GET /specs/:project/:name/sessions handler tests.
 *
 * Spec: openspec/changes/specs-tab-start-on-spec § Test Strategy.
 *
 * Coverage:
 *   - 404 for unknown spec slugs (neither live nor archived).
 *   - 200 with empty list when no links exist.
 *   - 200 with one active + one historical row (DESC by created_at).
 *
 * The DB chain is faked with the same minimal shape used by the route
 * handler (`db.select().from().leftJoin().where().orderBy()`). The fake
 * is shape-tight; an unexpected call throws so we notice contract drift.
 */

import { describe, it, expect, beforeEach, afterEach, afterAll } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { Db } from "@nexus/db";

// Use the injectable seam exported by session-spec-link rather than
// mock.module("../../services/config-loader"). Bun's module mocks are
// process-global and partial mocks leaked into config-loader.test.ts,
// causing spurious failures there. See spec-watcher/poller.ts for the
// canonical pattern this mirrors.
let scratchProjects: Array<{ code: string; name: string; path: string }> = [];

import {
  __setGetProjectsForTesting,
  __resetGetProjectsForTesting,
} from "../../services/session-spec-link";
import { handleListSpecSessions } from "./handlers-sessions";

__setGetProjectsForTesting(() => scratchProjects);
afterAll(() => {
  __resetGetProjectsForTesting();
});

interface FakeRow {
  id: number;
  sessionId: string;
  createdAt: Date;
  active: boolean;
}

function makeFakeDb(rows: FakeRow[]): Db {
  // Drizzle chain: db.select(cols).from(table).leftJoin(...).where(...).orderBy(...)
  return {
    select() {
      return {
        from() {
          return {
            leftJoin() {
              return {
                where() {
                  return {
                    orderBy() {
                      return Promise.resolve(rows);
                    },
                  };
                },
              };
            },
          };
        },
      };
    },
  } as unknown as Db;
}

function setupScratchProject(code = "nx") {
  const path = mkdtempSync(join(tmpdir(), `${code}-sslsess-`));
  mkdirSync(join(path, "openspec", "changes"), { recursive: true });
  scratchProjects = [{ code, name: code, path }];
  return path;
}

describe("handleListSpecSessions", () => {
  let projectPath: string;
  beforeEach(() => {
    projectPath = setupScratchProject();
  });
  afterEach(() => {
    rmSync(projectPath, { recursive: true, force: true });
    scratchProjects = [];
  });

  it("404s on unknown spec slug", async () => {
    const res = await handleListSpecSessions(
      makeFakeDb([]),
      "nx",
      "does-not-exist",
    );
    expect(res.status).toBe(404);
  });

  it("returns empty list when spec exists but has no links", async () => {
    mkdirSync(join(projectPath, "openspec", "changes", "empty-spec"), {
      recursive: true,
    });
    const res = await handleListSpecSessions(
      makeFakeDb([]),
      "nx",
      "empty-spec",
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { sessions: unknown[] };
    expect(body.sessions).toEqual([]);
  });

  it("returns one active + one historical row, newest first", async () => {
    mkdirSync(join(projectPath, "openspec", "changes", "ours"), {
      recursive: true,
    });
    const now = new Date("2026-05-21T10:00:00Z");
    const earlier = new Date("2026-05-20T10:00:00Z");
    const rows: FakeRow[] = [
      { id: 2, sessionId: "nx-active", createdAt: now, active: true },
      { id: 1, sessionId: "nx-historical", createdAt: earlier, active: false },
    ];
    const res = await handleListSpecSessions(makeFakeDb(rows), "nx", "ours");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      sessions: Array<{
        id: number;
        session_id: string;
        created_at: string;
        active: boolean;
      }>;
    };
    expect(body.sessions.length).toBe(2);
    expect(body.sessions[0]?.session_id).toBe("nx-active");
    expect(body.sessions[0]?.active).toBe(true);
    expect(body.sessions[1]?.session_id).toBe("nx-historical");
    expect(body.sessions[1]?.active).toBe(false);
  });
});
