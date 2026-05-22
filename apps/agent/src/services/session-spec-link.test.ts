/**
 * session-spec-link unit tests.
 *
 * Spec: openspec/changes/specs-tab-start-on-spec § Test Strategy.
 *
 * Coverage:
 *   - Happy path: live spec dir resolves + insert succeeds → linked: true.
 *   - Archived spec dir: resolves to archive/*-<slug>/ → linked: true.
 *   - Unknown slug (neither live nor archived) → linked: false, error: "spec not found".
 *   - Insert throw (DB error) → linked: false, error: "insert failed".
 *
 * Uses an os.tmpdir() scratch project so we don't touch the real openspec
 * tree, and stubs the config-loader's `getProjects` registry by writing a
 * mock projects.json into the user's `.claude` config path via env var
 * indirection — instead we register the project directly through the
 * config-loader cache. (The test patches `getProjects` via module
 * re-import, mirroring the existing health-history.test.ts harness.)
 */

import { describe, it, expect, beforeEach, afterEach, mock } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { Db } from "@nexus/db";

// Stub the config-loader BEFORE importing the unit under test so the
// service binds to our scratch registry. `mock.module()` is the Bun-test
// equivalent of vitest's `vi.mock`.
let scratchRoot: string;
let scratchProjects: Array<{ code: string; name: string; path: string }> = [];

mock.module("../services/config-loader", () => ({
  getProjects: () => scratchProjects,
}));

const { resolveSpecDir, linkSpecToSession } = await import("./session-spec-link");

interface InsertCall {
  project: string;
  specName: string;
  sessionId: string;
}

/** Minimal fake DB exposing the `db.insert(specSessions).values({...})` chain. */
function makeFakeDb(opts: { throwOnInsert?: boolean } = {}): {
  db: Db;
  calls: InsertCall[];
} {
  const calls: InsertCall[] = [];
  const db = {
    insert(_table: unknown) {
      return {
        values(v: InsertCall) {
          if (opts.throwOnInsert) {
            return Promise.reject(new Error("simulated insert failure"));
          }
          calls.push(v);
          return Promise.resolve();
        },
      };
    },
  } as unknown as Db;
  return { db, calls };
}

function setupScratchProject(projectCode: string): { projectPath: string } {
  const projectPath = mkdtempSync(join(tmpdir(), `${projectCode}-spec-link-`));
  mkdirSync(join(projectPath, "openspec", "changes"), { recursive: true });
  mkdirSync(join(projectPath, "openspec", "changes", "archive"), {
    recursive: true,
  });
  scratchProjects = [
    { code: projectCode, name: projectCode, path: projectPath },
  ];
  return { projectPath };
}

describe("resolveSpecDir", () => {
  beforeEach(() => {
    scratchRoot = mkdtempSync(join(tmpdir(), "sslspec-"));
    scratchProjects = [];
  });
  afterEach(() => {
    if (scratchRoot) rmSync(scratchRoot, { recursive: true, force: true });
    for (const p of scratchProjects) {
      rmSync(p.path, { recursive: true, force: true });
    }
  });

  it("resolves a live spec directory", () => {
    const { projectPath } = setupScratchProject("nx");
    mkdirSync(join(projectPath, "openspec", "changes", "my-live-spec"), {
      recursive: true,
    });
    const resolved = resolveSpecDir("nx", "my-live-spec");
    expect(resolved).toBe(
      join(projectPath, "openspec", "changes", "my-live-spec"),
    );
  });

  it("resolves an archived spec directory by trailing suffix", () => {
    const { projectPath } = setupScratchProject("nx");
    mkdirSync(
      join(projectPath, "openspec", "changes", "archive", "2026-05-01-my-archived"),
      { recursive: true },
    );
    const resolved = resolveSpecDir("nx", "my-archived");
    expect(resolved).toBe(
      join(projectPath, "openspec", "changes", "archive", "2026-05-01-my-archived"),
    );
  });

  it("returns null for unknown slugs", () => {
    setupScratchProject("nx");
    expect(resolveSpecDir("nx", "does-not-exist")).toBeNull();
  });

  it("returns null for unknown project codes", () => {
    setupScratchProject("nx");
    expect(resolveSpecDir("zz", "anything")).toBeNull();
  });

  it("rejects traversal attempts", () => {
    setupScratchProject("nx");
    expect(resolveSpecDir("nx", "../etc/passwd")).toBeNull();
    expect(resolveSpecDir("nx", "a/b")).toBeNull();
    expect(resolveSpecDir("nx", "")).toBeNull();
  });
});

describe("linkSpecToSession", () => {
  beforeEach(() => {
    scratchProjects = [];
  });
  afterEach(() => {
    for (const p of scratchProjects) {
      rmSync(p.path, { recursive: true, force: true });
    }
  });

  it("inserts a row on happy path (live spec)", async () => {
    const { projectPath } = setupScratchProject("nx");
    mkdirSync(join(projectPath, "openspec", "changes", "live-slug"), {
      recursive: true,
    });
    const { db, calls } = makeFakeDb();

    const result = await linkSpecToSession({
      db,
      project: "nx",
      specSlug: "live-slug",
      sessionId: "nx-1234",
    });

    expect(result.linked).toBe(true);
    expect(result.error).toBeUndefined();
    expect(calls).toEqual([
      { project: "nx", specName: "live-slug", sessionId: "nx-1234" },
    ]);
  });

  it("inserts a row for an archived spec (archives are valid link targets)", async () => {
    const { projectPath } = setupScratchProject("nx");
    mkdirSync(
      join(projectPath, "openspec", "changes", "archive", "2026-05-01-old-slug"),
      { recursive: true },
    );
    const { db, calls } = makeFakeDb();

    const result = await linkSpecToSession({
      db,
      project: "nx",
      specSlug: "old-slug",
      sessionId: "nx-archived",
    });

    expect(result.linked).toBe(true);
    expect(calls.length).toBe(1);
  });

  it("returns spec-not-found on unknown slugs without throwing", async () => {
    setupScratchProject("nx");
    const { db, calls } = makeFakeDb();

    const result = await linkSpecToSession({
      db,
      project: "nx",
      specSlug: "ghost",
      sessionId: "nx-ghost",
    });

    expect(result.linked).toBe(false);
    expect(result.error).toBe("spec not found");
    expect(calls.length).toBe(0);
  });

  it("returns insert-failed when the DB insert throws", async () => {
    const { projectPath } = setupScratchProject("nx");
    mkdirSync(join(projectPath, "openspec", "changes", "real-slug"), {
      recursive: true,
    });
    const { db } = makeFakeDb({ throwOnInsert: true });

    const result = await linkSpecToSession({
      db,
      project: "nx",
      specSlug: "real-slug",
      sessionId: "nx-fail",
    });

    expect(result.linked).toBe(false);
    expect(result.error).toBe("insert failed");
  });
});
