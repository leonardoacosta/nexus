/**
 * project-fanout tests (refocus-board-shell 2.3/2.4).
 *
 * Pure dependency-injected fixtures — NO `mock.module` (which is process-
 * global + forward-leaking in this single-process Bun suite). `resolveAllProjects`
 * takes `{ listProjects, listHidden }` seams; `fanOutAllProjects` takes the
 * compute/tag closures directly. Covers hidden exclusion, concurrent merge +
 * tagging, and per-project degradation.
 */

import { describe, it, expect } from "bun:test";
import type { Db } from "@nexus/db";
import {
  resolveAllProjects,
  fanOutAllProjects,
  type FanOutProject,
} from "./project-fanout";

const silentLog = { warn: () => {} };
const fakeDb = {} as Db;

describe("resolveAllProjects", () => {
  const projects = [
    { code: "a", path: "/dev/a" },
    { code: "b", path: "/dev/b" },
    { code: "c", path: "/dev/c" },
  ];

  it("returns all projects unfiltered when no db handle is given", async () => {
    const resolved = await resolveAllProjects(undefined, {
      listProjects: () => projects.slice(),
    });
    expect(resolved.map((p) => p.code)).toEqual(["a", "b", "c"]);
  });

  it("excludes projects whose registry path is marked hidden", async () => {
    const resolved = await resolveAllProjects(fakeDb, {
      listProjects: () => projects.slice(),
      listHidden: async () => [
        { path: "/dev/b", hidden: true },
        { path: "/dev/c", hidden: false },
      ],
    });
    expect(resolved.map((p) => p.code)).toEqual(["a", "c"]);
  });

  it("treats a project with no registry row as visible", async () => {
    const resolved = await resolveAllProjects(fakeDb, {
      listProjects: () => projects.slice(),
      // registry only knows about `a` (hidden); b/c have no row.
      listHidden: async () => [{ path: "/dev/a", hidden: true }],
    });
    expect(resolved.map((p) => p.code)).toEqual(["b", "c"]);
  });

  it("normalizes trailing slashes when matching hidden paths", async () => {
    const resolved = await resolveAllProjects(fakeDb, {
      listProjects: () => [{ code: "a", path: "/dev/a/" }],
      listHidden: async () => [{ path: "/dev/a", hidden: true }],
    });
    expect(resolved).toEqual([]);
  });

  it("degrades to no-filter when the registry read throws", async () => {
    const resolved = await resolveAllProjects(fakeDb, {
      listProjects: () => projects.slice(),
      listHidden: async () => {
        throw new Error("db down");
      },
    });
    expect(resolved.map((p) => p.code)).toEqual(["a", "b", "c"]);
  });
});

describe("fanOutAllProjects", () => {
  const projects: FanOutProject[] = [
    { code: "a", path: "/dev/a" },
    { code: "b", path: "/dev/b" },
    { code: "c", path: "/dev/c" },
  ];

  it("merges every project's entries, tagging each with its project code", async () => {
    const merged = await fanOutAllProjects<{ id: string; project?: string }>(
      projects,
      async (path) => [{ id: `${path}-1` }, { id: `${path}-2` }],
      (entry, project) => ({ ...entry, project }),
      silentLog,
    );
    expect(merged).toHaveLength(6);
    expect(merged.filter((e) => e.project === "a")).toHaveLength(2);
    expect(merged.every((e) => typeof e.project === "string")).toBe(true);
  });

  it("excludes a project whose compute rejects and keeps the survivors", async () => {
    const warnings: unknown[] = [];
    const merged = await fanOutAllProjects<{ id: string; project?: string }>(
      projects,
      async (path) => {
        if (path === "/dev/b") throw new Error("bd exploded");
        return [{ id: path }];
      },
      (entry, project) => ({ ...entry, project }),
      { warn: (obj: unknown) => warnings.push(obj) },
    );
    expect(merged.map((e) => e.project).sort()).toEqual(["a", "c"]);
    expect(warnings).toHaveLength(1);
  });

  it("returns [] when every project fails", async () => {
    const merged = await fanOutAllProjects<{ id: string }>(
      projects,
      async () => {
        throw new Error("all down");
      },
      (entry) => entry,
      silentLog,
    );
    expect(merged).toEqual([]);
  });

  it("skips a project that yields no entries without erroring", async () => {
    const merged = await fanOutAllProjects<{ id: string; project?: string }>(
      projects,
      async (path) => (path === "/dev/b" ? [] : [{ id: path }]),
      (entry, project) => ({ ...entry, project }),
      silentLog,
    );
    expect(merged.map((e) => e.project).sort()).toEqual(["a", "c"]);
  });

  it("bounds the number of concurrently-live compute closures (nx-veo5g.2 #1)", async () => {
    const many: FanOutProject[] = Array.from({ length: 12 }, (_, i) => ({
      code: `p${i}`,
      path: `/dev/p${i}`,
    }));

    let live = 0;
    let peak = 0;
    const merged = await fanOutAllProjects<{ id: string; project?: string }>(
      many,
      async (path) => {
        live++;
        peak = Math.max(peak, live);
        await new Promise((resolve) => setTimeout(resolve, 10));
        live--;
        return [{ id: path }];
      },
      (entry, project) => ({ ...entry, project }),
      silentLog,
      3, // explicit concurrency cap
    );

    // Every project still contributes; the fan-out just never ran >3 at once
    // (the fix for the unbounded Promise.allSettled subprocess storm).
    expect(merged).toHaveLength(12);
    expect(peak).toBe(3);
  });

  it("preserves per-project degradation under bounded concurrency", async () => {
    const warnings: unknown[] = [];
    const merged = await fanOutAllProjects<{ id: string; project?: string }>(
      projects,
      async (path) => {
        if (path === "/dev/b") throw new Error("queue overflow / bd down");
        return [{ id: path }];
      },
      (entry, project) => ({ ...entry, project }),
      { warn: (obj: unknown) => warnings.push(obj) },
      2,
    );
    expect(merged.map((e) => e.project).sort()).toEqual(["a", "c"]);
    expect(warnings).toHaveLength(1);
  });
});
