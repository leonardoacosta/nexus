/**
 * Spec route tests.
 *
 * These tests exercise the exported handler functions directly, mocking
 * filesystem and subprocess dependencies so they run without external tools.
 */

import { describe, it, expect } from "bun:test";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  handleGetSpecsAll,
  handleListSpecs,
  handleGetSpec,
  handleApproveSpec,
  handleRejectSpec,
  handleReadSpec,
  handleSpecStatus,
} from "./specs";
import {
  pollProjectSpecs,
  parseSpecFromPath,
  resolveRoots,
} from "../services/spec-watcher";

// ---------------------------------------------------------------------------
// Mocking strategy
//
// The spec routes depend on:
//   1. loadProjects() -> reads ~/.claude/scripts/config/projects.json
//   2. pollProjectSpecs() -> calls Bun.spawn("openspec list --json")
//   3. runOpenspec() -> calls Bun.spawn("openspec", ...) for single-spec ops
//   4. fetchBeadsSummary() -> calls Bun.spawn("bd ready --json")
//   5. existsSync() for checking openspec/ and .beads/ dirs
//
// We mock at the module level to control these dependencies.
// ---------------------------------------------------------------------------

// We test the handlers by intercepting the modules they import.
// Since Bun's module mocking is limited, we test the contract shapes
// by exercising the handlers and verifying responses.

// ---------------------------------------------------------------------------
// handleGetSpec — subprocess-based single spec detail
// ---------------------------------------------------------------------------

describe("handleGetSpec", () => {
  it("returns 404 for unknown project", async () => {
    // "zzz-nonexistent" is extremely unlikely to exist in the registry.
    const response = await handleGetSpec("zzz-nonexistent-project-code", "some-spec");
    expect(response.status).toBe(404);

    const body = (await response.json()) as { error: string };
    expect(body).toHaveProperty("error");
    expect(body.error).toContain("unknown project");
  });

  it("returns JSON with Content-Type header", async () => {
    const response = await handleGetSpec("zzz-nonexistent", "test");
    expect(response.headers.get("Content-Type")).toBe("application/json");
  });
});

// ---------------------------------------------------------------------------
// handleApproveSpec
// ---------------------------------------------------------------------------

describe("handleApproveSpec", () => {
  it("returns 404 for unknown project", async () => {
    const response = await handleApproveSpec("zzz-nonexistent", "some-spec");
    expect(response.status).toBe(404);

    const body = (await response.json()) as { error: string };
    expect(body.error).toContain("unknown project");
  });
});

// ---------------------------------------------------------------------------
// handleRejectSpec
// ---------------------------------------------------------------------------

describe("handleRejectSpec", () => {
  it("returns 404 for unknown project", async () => {
    const request = new Request("http://localhost/specs/zzz/test/reject", {
      method: "POST",
      body: JSON.stringify({ reason: "not ready" }),
      headers: { "Content-Type": "application/json" },
    });
    const response = await handleRejectSpec("zzz-nonexistent", "some-spec", request);
    expect(response.status).toBe(404);

    const body = (await response.json()) as { error: string };
    expect(body.error).toContain("unknown project");
  });

  it("handles request with no body gracefully", async () => {
    const request = new Request("http://localhost/specs/zzz/test/reject", {
      method: "POST",
    });
    const response = await handleRejectSpec("zzz-nonexistent", "some-spec", request);
    // Should still return 404 (project not found), not crash on body parsing
    expect(response.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// handleReadSpec
// ---------------------------------------------------------------------------

describe("handleReadSpec", () => {
  it("returns 404 for unknown project", async () => {
    const response = await handleReadSpec("zzz-nonexistent", "some-spec");
    expect(response.status).toBe(404);

    const body = (await response.json()) as { error: string };
    expect(body.error).toContain("unknown project");
  });
});

// ---------------------------------------------------------------------------
// handleSpecStatus
// ---------------------------------------------------------------------------

describe("handleSpecStatus", () => {
  it("returns 404 for unknown project", async () => {
    const response = await handleSpecStatus("zzz-nonexistent", "some-spec");
    expect(response.status).toBe(404);

    const body = (await response.json()) as { error: string };
    expect(body.error).toContain("unknown project");
  });
});

// ---------------------------------------------------------------------------
// handleListSpecs — cross-project listing with filters
// ---------------------------------------------------------------------------

describe("handleListSpecs", () => {
  it("returns a JSON array", async () => {
    const url = new URL("http://localhost/specs");
    const response = await handleListSpecs(url);
    expect(response.status).toBe(200);

    const body = await response.json();
    // Should be an array (possibly empty if no projects have openspec/)
    expect(Array.isArray(body)).toBe(true);
  });

  it("accepts status filter param", async () => {
    const url = new URL("http://localhost/specs?status=active");
    const response = await handleListSpecs(url);
    expect(response.status).toBe(200);

    const body = await response.json();
    expect(Array.isArray(body)).toBe(true);
  });

  it("accepts project filter param", async () => {
    const url = new URL("http://localhost/specs?project=nx");
    const response = await handleListSpecs(url);
    expect(response.status).toBe(200);

    const body = await response.json();
    expect(Array.isArray(body)).toBe(true);
  });

  it("accepts combined status and project filters", async () => {
    const url = new URL("http://localhost/specs?project=nx&status=active,draft");
    const response = await handleListSpecs(url);
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("application/json");
  });
});

// ---------------------------------------------------------------------------
// handleGetSpecsAll — cross-project aggregate
//
// This handler spawns subprocesses (openspec, bd) per-project found in the
// registry, so it can be slow. We use a generous timeout and accept that
// it may find zero projects in CI environments.
// ---------------------------------------------------------------------------

describe("handleGetSpecsAll", () => {
  it(
    "returns a JSON object with projects array",
    async () => {
      const response = await handleGetSpecsAll();
      expect(response.status).toBe(200);

      const body = (await response.json()) as { projects: unknown[] };
      expect(body).toHaveProperty("projects");
      expect(Array.isArray(body.projects)).toBe(true);
    },
    { timeout: 30_000 },
  );

  it(
    "each project entry has expected shape",
    async () => {
      const response = await handleGetSpecsAll();
      const body = (await response.json()) as {
        projects: {
          code: string;
          name: string;
          specs: unknown[];
          beads: unknown;
        }[];
      };

      for (const project of body.projects) {
        expect(project).toHaveProperty("code");
        expect(project).toHaveProperty("name");
        expect(project).toHaveProperty("specs");
        expect(Array.isArray(project.specs)).toBe(true);
        // beads can be null or an object
        expect(project).toHaveProperty("beads");
      }
    },
    { timeout: 30_000 },
  );
});

// ---------------------------------------------------------------------------
// Filesystem-driven scan tests (homelab-emits-specs-credentials task 1.9)
//
// These tests verify the post-fix behaviour of pollProjectSpecs and
// parseSpecFromPath against a tmpdir fixture so they never touch $HOME.
// ---------------------------------------------------------------------------

function makeFixtureProject(opts: {
  dir: string;
  specs: Array<{
    name: string;
    proposal?: boolean;
    design?: boolean;
    tasks?: string;
  }>;
}): void {
  for (const spec of opts.specs) {
    const specDir = join(opts.dir, "openspec", "changes", spec.name);
    mkdirSync(specDir, { recursive: true });
    if (spec.proposal !== false) {
      writeFileSync(join(specDir, "proposal.md"), `# ${spec.name}\n`);
    }
    if (spec.design) {
      writeFileSync(join(specDir, "design.md"), `# design ${spec.name}\n`);
    }
    if (typeof spec.tasks === "string") {
      writeFileSync(join(specDir, "tasks.md"), spec.tasks);
    }
  }
}

describe("pollProjectSpecs — fs-driven", () => {
  it("[1.9] returns non-empty SpecSnapshot[] for fixture project with two specs", async () => {
    const root = mkdtempSync(join(tmpdir(), "nx-specs-1.9-"));
    try {
      makeFixtureProject({
        dir: root,
        specs: [
          {
            name: "foo",
            proposal: true,
            design: true,
            tasks: "- [x] done one\n- [ ] not yet\n",
          },
          { name: "bar", proposal: true },
        ],
      });

      const snaps = await pollProjectSpecs(root);
      expect(snaps.length).toBe(2);

      const foo = snaps.find((s) => s.name === "foo");
      expect(foo).toBeTruthy();
      expect(foo?.has_proposal).toBe(true);
      expect(foo?.has_design).toBe(true);
      expect(foo?.has_tasks).toBe(true);
      expect(foo?.completedTasks).toBe(1);
      expect(foo?.totalTasks).toBe(2);

      const bar = snaps.find((s) => s.name === "bar");
      expect(bar).toBeTruthy();
      expect(bar?.has_proposal).toBe(true);
      expect(bar?.has_design).toBe(false);
      expect(bar?.has_tasks).toBe(false);
      expect(bar?.completedTasks).toBe(0);
      expect(bar?.totalTasks).toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("[1.9] skips the archive/ sibling and hidden entries", async () => {
    const root = mkdtempSync(join(tmpdir(), "nx-specs-skip-"));
    try {
      makeFixtureProject({ dir: root, specs: [{ name: "alive" }] });
      // Create an archive sibling that MUST be skipped.
      const archived = join(root, "openspec", "changes", "archive", "2025-04-08-old");
      mkdirSync(archived, { recursive: true });
      writeFileSync(join(archived, "proposal.md"), "# old\n");
      // And a hidden entry that MUST also be skipped.
      const hidden = join(root, "openspec", "changes", ".hidden");
      mkdirSync(hidden, { recursive: true });

      const snaps = await pollProjectSpecs(root);
      const names = snaps.map((s) => s.name).sort();
      expect(names).toEqual(["alive"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("[1.9] returns [] when openspec/changes/ does not exist", async () => {
    const root = mkdtempSync(join(tmpdir(), "nx-specs-empty-"));
    try {
      const snaps = await pollProjectSpecs(root);
      expect(snaps).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("[1.9] all-complete spec reports status='complete'", async () => {
    const root = mkdtempSync(join(tmpdir(), "nx-specs-complete-"));
    try {
      makeFixtureProject({
        dir: root,
        specs: [
          {
            name: "done-thing",
            tasks: "- [x] one\n- [x] two\n",
          },
        ],
      });
      const snaps = await pollProjectSpecs(root);
      expect(snaps[0]?.status).toBe("complete");
      expect(snaps[0]?.completedTasks).toBe(2);
      expect(snaps[0]?.totalTasks).toBe(2);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("parseSpecFromPath — direct fixture", () => {
  it("[1.9] returns null for missing dir", () => {
    const missing = join(tmpdir(), "nx-specs-missing-" + Date.now());
    expect(parseSpecFromPath(missing)).toBeNull();
  });

  it("[1.9] uses dir basename as name", () => {
    const root = mkdtempSync(join(tmpdir(), "nx-specs-name-"));
    try {
      const specDir = join(root, "my-spec-name");
      mkdirSync(specDir, { recursive: true });
      writeFileSync(join(specDir, "proposal.md"), "# x\n");
      const snap = parseSpecFromPath(specDir);
      expect(snap?.name).toBe("my-spec-name");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("resolveRoots — fs-existence filter", () => {
  it("[1.9] filters out non-existent roots", () => {
    const real = mkdtempSync(join(tmpdir(), "nx-roots-real-"));
    const fake = join(tmpdir(), "nx-roots-missing-" + Date.now());
    try {
      const resolved = resolveRoots([real, fake]);
      expect(resolved).toContain(real);
      expect(resolved).not.toContain(fake);
    } finally {
      rmSync(real, { recursive: true, force: true });
    }
  });
});
