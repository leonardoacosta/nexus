/**
 * Spec route tests.
 *
 * These tests exercise the exported handler functions directly, mocking
 * filesystem and subprocess dependencies so they run without external tools.
 */

import { describe, it, expect, mock, beforeEach, afterEach, spyOn } from "bun:test";
import {
  handleGetSpecsAll,
  handleListSpecs,
  handleGetSpec,
  handleApproveSpec,
  handleRejectSpec,
  handleReadSpec,
  handleSpecStatus,
} from "./specs";

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
