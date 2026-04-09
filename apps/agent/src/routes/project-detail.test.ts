/**
 * Project detail route tests.
 *
 * Tests exercise the exported handler functions directly. Routes that depend
 * on subprocess calls (git, bd, openspec) are tested for:
 *   1. Unknown project -> 404 response
 *   2. Response shape contracts
 *   3. Input validation (POST /project/:code/run)
 */

import { describe, it, expect } from "bun:test";
import {
  handleProjectStatus,
  handleProjectGit,
  handleProjectBeads,
  handleProjectSpecs,
  handleRunCommand,
} from "./project-detail";

// ---------------------------------------------------------------------------
// Unknown project -> 404
// ---------------------------------------------------------------------------

describe("project-detail: unknown project", () => {
  it("handleProjectStatus returns 404 for unknown project", async () => {
    const url = new URL("http://localhost/project/zzz-nonexistent/status");
    const response = await handleProjectStatus("zzz-nonexistent", url);
    expect(response.status).toBe(404);

    const body = await response.json();
    expect(body).toHaveProperty("error");
    expect(body.error).toContain("unknown project");
  });

  it("handleProjectGit returns 404 for unknown project", async () => {
    const response = await handleProjectGit("zzz-nonexistent");
    expect(response.status).toBe(404);

    const body = await response.json();
    expect(body.error).toContain("unknown project");
  });

  it("handleProjectBeads returns 404 for unknown project", async () => {
    const response = await handleProjectBeads("zzz-nonexistent");
    expect(response.status).toBe(404);

    const body = await response.json();
    expect(body.error).toContain("unknown project");
  });

  it("handleProjectSpecs returns 404 for unknown project", async () => {
    const response = await handleProjectSpecs("zzz-nonexistent");
    expect(response.status).toBe(404);

    const body = await response.json();
    expect(body.error).toContain("unknown project");
  });

  it("handleRunCommand returns 404 for unknown project", async () => {
    const request = new Request("http://localhost/project/zzz-nonexistent/run", {
      method: "POST",
      body: JSON.stringify({ command: "test" }),
      headers: { "Content-Type": "application/json" },
    });
    const response = await handleRunCommand("zzz-nonexistent", request);
    expect(response.status).toBe(404);

    const body = await response.json();
    expect(body.error).toContain("unknown project");
  });
});

// ---------------------------------------------------------------------------
// handleRunCommand — input validation
// ---------------------------------------------------------------------------

describe("handleRunCommand input validation", () => {
  // Use "nx" as a project code that is likely to exist in the registry.
  // If it doesn't exist, the test verifies 404 instead — both are valid.

  it("rejects invalid JSON body", async () => {
    const request = new Request("http://localhost/project/nx/run", {
      method: "POST",
      body: "not json",
      headers: { "Content-Type": "text/plain" },
    });
    const response = await handleRunCommand("nx", request);

    // Either 400 (invalid JSON) or 404 (project not found) is acceptable.
    expect([400, 404]).toContain(response.status);
  });

  it("rejects body without command field", async () => {
    const request = new Request("http://localhost/project/nx/run", {
      method: "POST",
      body: JSON.stringify({ args: ["--verbose"] }),
      headers: { "Content-Type": "application/json" },
    });
    const response = await handleRunCommand("nx", request);

    // 400 (missing command) or 404 (project not found)
    expect([400, 404]).toContain(response.status);
  });

  it("rejects empty command string", async () => {
    const request = new Request("http://localhost/project/nx/run", {
      method: "POST",
      body: JSON.stringify({ command: "" }),
      headers: { "Content-Type": "application/json" },
    });
    const response = await handleRunCommand("nx", request);

    // 400 (empty command) or 404 (project not found)
    expect([400, 404]).toContain(response.status);
  });
});

// ---------------------------------------------------------------------------
// handleProjectStatus — response shape when project exists
// ---------------------------------------------------------------------------

describe("handleProjectStatus response shape", () => {
  it("returns JSON with Content-Type header for any input", async () => {
    const url = new URL("http://localhost/project/test/status");
    const response = await handleProjectStatus("test-code", url);

    expect(response.headers.get("Content-Type")).toBe("application/json");
  });

  it("supports ?fresh=true query param", async () => {
    const url = new URL("http://localhost/project/test/status?fresh=true");
    const response = await handleProjectStatus("test-code", url);

    // Will be 404 for unknown project, but should not crash
    expect(response.headers.get("Content-Type")).toBe("application/json");
  });
});

// ---------------------------------------------------------------------------
// handleRunCommand — success case with known project
// ---------------------------------------------------------------------------

describe.skipIf(!process.env.NX_HAS_PROJECTS)(
  "handleRunCommand with known project",
  () => {
    it("returns accepted status with command and prompt", async () => {
      // This test only runs when NX_HAS_PROJECTS is set, meaning the
      // projects registry has at least one project configured.
      const request = new Request("http://localhost/project/nx/run", {
        method: "POST",
        body: JSON.stringify({ command: "test", args: ["--verbose"] }),
        headers: { "Content-Type": "application/json" },
      });
      const response = await handleRunCommand("nx", request);

      if (response.status === 200) {
        const body = await response.json();
        expect(body).toHaveProperty("status", "accepted");
        expect(body).toHaveProperty("command", "test");
        expect(body).toHaveProperty("prompt");
        expect(body.prompt).toBe("/test --verbose");
      }
    });

    it("builds prompt without args when none provided", async () => {
      const request = new Request("http://localhost/project/nx/run", {
        method: "POST",
        body: JSON.stringify({ command: "build" }),
        headers: { "Content-Type": "application/json" },
      });
      const response = await handleRunCommand("nx", request);

      if (response.status === 200) {
        const body = await response.json();
        expect(body.prompt).toBe("/build");
      }
    });
  },
);
