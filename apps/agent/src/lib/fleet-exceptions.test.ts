/**
 * Fleet exceptions + beads reader tests (add-fleet-exceptions-feed 1.4).
 *
 * Fixture-only: builds throwaway `~/dev`-shaped roots with `.beads/issues.jsonl`
 * stores (the JSONL fallback path — nx runs Dolt embedded, no sql-server). No
 * network, no real fleet. Covers the reader's JSONL/corrupt/missing contract,
 * per-class thresholds, the skipped-not-thrown contract, and the offender cap.
 */

import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  discoverDolt,
  readViaJsonl,
  type BeadRow,
} from "./beads-reader";
import {
  classifyRepo,
  computeFleetExceptions,
  OFFENDER_CAP,
} from "./fleet-exceptions";

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

const DAY_MS = 24 * 60 * 60 * 1000;
const NOW = Date.parse("2026-07-07T00:00:00Z");
const now = () => NOW;
const daysAgo = (n: number) => new Date(NOW - n * DAY_MS).toISOString();

interface IssueSpec {
  id: string;
  status?: string;
  priority?: number;
  issue_type?: string;
  created_at?: string;
  updated_at?: string;
  started_at?: string;
  dependency_count?: number;
}

function issueLine(spec: IssueSpec): string {
  return JSON.stringify({
    _type: "issue",
    title: spec.id,
    status: "open",
    priority: 2,
    issue_type: "task",
    created_at: daysAgo(1),
    updated_at: daysAgo(1),
    dependency_count: 0,
    labels: [],
    ...spec,
  });
}

const tmpDirs: string[] = [];

function makeDevRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "nx-fleet-exc-"));
  tmpDirs.push(root);
  return root;
}

/** Write a repo dir with a `.beads/issues.jsonl` (or raw content) + optional changes. */
function writeRepo(
  devRoot: string,
  repo: string,
  opts: { issues?: IssueSpec[]; rawJsonl?: string; changeSlugs?: string[]; noBeads?: boolean } = {},
): void {
  const repoPath = join(devRoot, repo);
  mkdirSync(repoPath, { recursive: true });
  if (!opts.noBeads) {
    const beadsDir = join(repoPath, ".beads");
    mkdirSync(beadsDir, { recursive: true });
    const body =
      opts.rawJsonl ??
      (opts.issues ?? []).map(issueLine).join("\n") + "\n";
    writeFileSync(join(beadsDir, "issues.jsonl"), body);
  }
  for (const slug of opts.changeSlugs ?? []) {
    mkdirSync(join(repoPath, "openspec", "changes", slug), { recursive: true });
  }
}

afterEach(() => {
  while (tmpDirs.length) rmSync(tmpDirs.pop()!, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// beads-reader — JSONL / corrupt / missing / discovery
// ---------------------------------------------------------------------------

describe("beads-reader", () => {
  it("readViaJsonl parses valid lines and skips malformed ones", async () => {
    const root = makeDevRoot();
    const beadsDir = join(root, ".beads");
    mkdirSync(beadsDir, { recursive: true });
    writeFileSync(
      join(beadsDir, "issues.jsonl"),
      [
        issueLine({ id: "nx-1", priority: 0 }),
        "{ this is not json",
        "", // blank tolerated
        issueLine({ id: "nx-2", status: "in_progress" }),
      ].join("\n"),
    );
    const rows = await readViaJsonl(beadsDir);
    expect(rows).not.toBeNull();
    expect(rows!.map((r) => r.id).sort()).toEqual(["nx-1", "nx-2"]);
    expect(rows!.find((r) => r.id === "nx-1")!.priority).toBe(0);
  });

  it("readViaJsonl returns null for a corrupt store (content, zero valid)", async () => {
    const root = makeDevRoot();
    const beadsDir = join(root, ".beads");
    mkdirSync(beadsDir, { recursive: true });
    writeFileSync(join(beadsDir, "issues.jsonl"), "garbage\n{bad\nnope");
    expect(await readViaJsonl(beadsDir)).toBeNull();
  });

  it("readViaJsonl returns null when issues.jsonl is missing", async () => {
    const root = makeDevRoot();
    const beadsDir = join(root, ".beads");
    mkdirSync(beadsDir, { recursive: true });
    expect(await readViaJsonl(beadsDir)).toBeNull();
  });

  it("readViaJsonl returns [] for a genuinely empty store", async () => {
    const root = makeDevRoot();
    const beadsDir = join(root, ".beads");
    mkdirSync(beadsDir, { recursive: true });
    writeFileSync(join(beadsDir, "issues.jsonl"), "\n\n");
    expect(await readViaJsonl(beadsDir)).toEqual([]);
  });

  it("discoverDolt returns null in embedded mode (no port)", async () => {
    const root = makeDevRoot();
    const beadsDir = join(root, ".beads");
    mkdirSync(beadsDir, { recursive: true });
    writeFileSync(
      join(beadsDir, "metadata.json"),
      JSON.stringify({ dolt_mode: "embedded", dolt_database: "nx" }),
    );
    expect(await discoverDolt(beadsDir)).toBeNull();
  });

  it("discoverDolt reads the dolt-server.port sidecar when present", async () => {
    const root = makeDevRoot();
    const beadsDir = join(root, ".beads");
    mkdirSync(beadsDir, { recursive: true });
    writeFileSync(
      join(beadsDir, "metadata.json"),
      JSON.stringify({ dolt_database: "nx" }),
    );
    writeFileSync(join(beadsDir, "dolt-server.port"), "3307\n");
    expect(await discoverDolt(beadsDir)).toEqual({ database: "nx", port: 3307 });
  });
});

// ---------------------------------------------------------------------------
// classifyRepo — pure per-class thresholds + offender cap
// ---------------------------------------------------------------------------

function row(spec: IssueSpec): BeadRow {
  return {
    id: spec.id,
    title: spec.id,
    status: spec.status ?? "open",
    priority: spec.priority ?? 2,
    issueType: spec.issue_type ?? "task",
    createdAt: spec.created_at ?? daysAgo(1),
    updatedAt: spec.updated_at ?? daysAgo(1),
    startedAt: spec.started_at ?? null,
    closedAt: null,
    dependencyCount: spec.dependency_count ?? 0,
    labels: [],
  };
}

describe("classifyRepo", () => {
  const empty = { count: 0, slugs: [] as string[] };

  it("flags P0 and P1 open beads, worst (oldest) first", () => {
    const rows = [
      row({ id: "p0-new", priority: 0, created_at: daysAgo(1) }),
      row({ id: "p0-old", priority: 0, created_at: daysAgo(50) }),
      row({ id: "p1", priority: 1 }),
      row({ id: "p2", priority: 2 }),
      row({ id: "p0-closed", priority: 0, status: "closed" }),
    ];
    const out = classifyRepo("nx", rows, empty, NOW);
    const p0 = out.find((e) => e.class === "p0_open")!;
    expect(p0.count).toBe(2);
    expect(p0.offenders[0]).toBe("p0-old"); // oldest first
    expect(out.find((e) => e.class === "p1_open")!.count).toBe(1);
  });

  it("flags in_progress claims stale > 7 days only", () => {
    const rows = [
      row({ id: "fresh", status: "in_progress", started_at: daysAgo(3) }),
      row({ id: "stale", status: "in_progress", started_at: daysAgo(20) }),
    ];
    const out = classifyRepo("nx", rows, empty, NOW);
    const e = out.find((x) => x.class === "in_progress_stale")!;
    expect(e.count).toBe(1);
    expect(e.offenders).toEqual(["stale"]);
  });

  it("flags ready-head (open, unblocked) older than 30 days", () => {
    const rows = [
      row({ id: "young", status: "open", created_at: daysAgo(10) }),
      row({ id: "old", status: "open", created_at: daysAgo(40) }),
      row({ id: "blocked-old", status: "open", created_at: daysAgo(40), dependency_count: 1 }),
    ];
    const out = classifyRepo("nx", rows, empty, NOW);
    const e = out.find((x) => x.class === "ready_head_stale")!;
    expect(e.count).toBe(1);
    expect(e.offenders).toEqual(["old"]);
  });

  it("emits unarchived_changes when count > 0, slugs capped", () => {
    const out = classifyRepo("nx", [], { count: 5, slugs: ["a", "b", "c", "d", "e"] }, NOW);
    const e = out.find((x) => x.class === "unarchived_changes")!;
    expect(e.count).toBe(5);
    expect(e.offenders).toEqual(["a", "b", "c"]); // capped, sorted
  });

  it("caps offenders at OFFENDER_CAP", () => {
    const rows = Array.from({ length: 10 }, (_, i) =>
      row({ id: `p0-${i}`, priority: 0, created_at: daysAgo(i) }),
    );
    const out = classifyRepo("nx", rows, empty, NOW);
    const p0 = out.find((e) => e.class === "p0_open")!;
    expect(p0.count).toBe(10);
    expect(p0.offenders.length).toBe(OFFENDER_CAP);
  });

  it("returns [] for a clean repo", () => {
    expect(classifyRepo("nx", [row({ id: "ok", priority: 2 })], empty, NOW)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// computeFleetExceptions — fleet walk, skipped-not-thrown, clean-empty
// ---------------------------------------------------------------------------

describe("computeFleetExceptions", () => {
  it("returns an empty exceptions array for a clean fleet", async () => {
    const devRoot = makeDevRoot();
    writeRepo(devRoot, "clean-a", { issues: [{ id: "a1", priority: 2 }] });
    writeRepo(devRoot, "clean-b", { issues: [{ id: "b1", priority: 3 }] });
    const res = await computeFleetExceptions({ devRoot, now });
    expect(res.exceptions).toEqual([]);
    expect(res.skipped).toEqual([]);
  });

  it("skips a corrupt store instead of throwing", async () => {
    const devRoot = makeDevRoot();
    writeRepo(devRoot, "good", { issues: [{ id: "g1", priority: 0 }] });
    writeRepo(devRoot, "corrupt", { rawJsonl: "not json at all\n{broken" });
    const res = await computeFleetExceptions({ devRoot, now });
    expect(res.skipped).toContainEqual({ repo: "corrupt", reason: "corrupt_store" });
    // The healthy repo still produced its P0 exception.
    expect(res.exceptions.some((e) => e.repo === "good" && e.class === "p0_open")).toBe(true);
  });

  it("records missing_store when .beads has no issues.jsonl", async () => {
    const devRoot = makeDevRoot();
    const beadsDir = join(devRoot, "empty-beads", ".beads");
    mkdirSync(beadsDir, { recursive: true });
    const res = await computeFleetExceptions({ devRoot, now });
    expect(res.skipped).toContainEqual({ repo: "empty-beads", reason: "missing_store" });
  });

  it("ignores repos with no .beads dir entirely", async () => {
    const devRoot = makeDevRoot();
    writeRepo(devRoot, "no-beads", { noBeads: true });
    const res = await computeFleetExceptions({ devRoot, now });
    expect(res.exceptions).toEqual([]);
    expect(res.skipped).toEqual([]);
  });

  it("classifies across the fleet and includes the unarchived-changes signal", async () => {
    const devRoot = makeDevRoot();
    writeRepo(devRoot, "nx", {
      issues: [
        { id: "nx-p0", priority: 0 },
        { id: "nx-stale", status: "in_progress", started_at: daysAgo(15) },
      ],
      changeSlugs: ["add-fleet-exceptions-feed", "add-thing"],
    });
    const res = await computeFleetExceptions({ devRoot, now });
    const classes = res.exceptions.filter((e) => e.repo === "nx").map((e) => e.class).sort();
    expect(classes).toEqual(["in_progress_stale", "p0_open", "unarchived_changes"]);
    const changes = res.exceptions.find((e) => e.class === "unarchived_changes")!;
    expect(changes.count).toBe(2);
  });

  it("degrades to an empty result when the fleet root is unreadable", async () => {
    const res = await computeFleetExceptions({
      devRoot: join(tmpdir(), "nx-does-not-exist-zzz"),
      now,
    });
    expect(res).toEqual({ exceptions: [], skipped: [] });
  });

  it("finds a repo nested one category level deep (~/dev/personal/nexus)", async () => {
    const devRoot = makeDevRoot();
    // ~/dev/personal is a category dir (no .git, no .beads of its own).
    writeRepo(join(devRoot, "personal"), "nexus", {
      issues: [{ id: "nx-p0", priority: 0 }],
    });
    const res = await computeFleetExceptions({ devRoot, now });
    const nx = res.exceptions.find((e) => e.repo === "nexus" && e.class === "p0_open");
    expect(nx).toBeDefined();
    expect(nx!.count).toBe(1);
  });

  it("does not descend into a top-level entry that is itself a git repo", async () => {
    const devRoot = makeDevRoot();
    const repoPath = join(devRoot, "some-repo");
    mkdirSync(join(repoPath, ".git"), { recursive: true });
    // Nested dir that LOOKS like a leaf, but sits inside a real repo — must
    // never be discovered, since "some-repo" is a git repo, not a category.
    writeRepo(repoPath, "nested-fake", { issues: [{ id: "should-not-appear", priority: 0 }] });
    const res = await computeFleetExceptions({ devRoot, now });
    expect(res.exceptions).toEqual([]);
    expect(res.skipped).toEqual([]);
  });

  it("still finds a flat depth-1 repo alongside a category-nested one", async () => {
    const devRoot = makeDevRoot();
    writeRepo(devRoot, "cc", { issues: [{ id: "cc-p0", priority: 0 }] });
    writeRepo(join(devRoot, "personal"), "nexus", { issues: [{ id: "nx-p0", priority: 0 }] });
    const res = await computeFleetExceptions({ devRoot, now });
    const repos = res.exceptions.map((e) => e.repo).sort();
    expect(repos).toEqual(["cc", "nexus"]);
  });
});
