/**
 * PATCH /specs/:project/:name/status handler tests.
 *
 * Spec: openspec/changes/specs-tab-start-on-spec § Test Strategy.
 *
 * Coverage:
 *   - 200 draft→approved writes status + approved-by + approved-at.
 *   - 200 approved→draft removes approved-by + approved-at.
 *   - 400 on invalid status.
 *   - 400 on malformed JSON.
 *   - 404 on unknown spec slug.
 *   - 404 on missing proposal.md.
 *   - 409 on archived spec.
 *   - SpecTransition status_change emitted on success.
 *
 * Uses real-FS scratch dirs (os.tmpdir()) per the project test convention
 * (no mocks for filesystem operations). `lifecycleBus` is observed via an
 * one-off listener registered per test.
 */

import { describe, it, expect, beforeEach, afterEach, mock } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

let scratchProjects: Array<{ code: string; name: string; path: string }> = [];

mock.module("../../services/config-loader", () => ({
  getProjects: () => scratchProjects,
}));

const { handlePatchSpecStatus, spliceFrontmatter } = await import("./handlers-status");
const { lifecycleBus } = await import("../../services/lifecycle-bus");

function setupScratchProject(code = "nx") {
  const path = mkdtempSync(join(tmpdir(), `${code}-spec-status-`));
  mkdirSync(join(path, "openspec", "changes"), { recursive: true });
  mkdirSync(join(path, "openspec", "changes", "archive"), { recursive: true });
  scratchProjects = [{ code, name: code, path }];
  return path;
}

function makeProposal(
  projectPath: string,
  slug: string,
  frontmatter: string,
  archived = false,
): string {
  const dir = archived
    ? join(projectPath, "openspec", "changes", "archive", `2026-05-01-${slug}`)
    : join(projectPath, "openspec", "changes", slug);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, "proposal.md");
  writeFileSync(
    file,
    `---\n${frontmatter}---\n# Proposal: ${slug}\n\nbody\n`,
    "utf8",
  );
  return file;
}

function jsonRequest(body: unknown): Request {
  return new Request("http://test/", {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

describe("spliceFrontmatter", () => {
  it("upserts existing keys and preserves order", () => {
    const src = "---\nfoo: 1\nbar: 2\n---\nbody\n";
    const out = spliceFrontmatter(src, { foo: "9", baz: "3" }, new Set());
    expect(out).toBe("---\nfoo: 9\nbar: 2\nbaz: 3\n---\nbody\n");
  });

  it("removes keys named in the removes set", () => {
    const src = "---\nstatus: approved\napproved-by: a\napproved-at: t\n---\nbody";
    const out = spliceFrontmatter(
      src,
      { status: "draft" },
      new Set(["approved-by", "approved-at"]),
    );
    expect(out).toBe("---\nstatus: draft\n---\nbody");
  });

  it("creates a fresh frontmatter block when none exists", () => {
    const src = "# Proposal\n\nbody\n";
    const out = spliceFrontmatter(src, { status: "approved" }, new Set());
    expect(out.startsWith("---\nstatus: approved\n---\n")).toBe(true);
  });
});

describe("handlePatchSpecStatus", () => {
  let projectPath: string;
  let busEvents: Array<{ event: string; payload: unknown }>;
  let listener: (env: { event: string; payload: unknown }) => void;

  beforeEach(() => {
    projectPath = setupScratchProject();
    busEvents = [];
    listener = (env) => {
      if (env.event === "SpecTransition") busEvents.push(env);
    };
    lifecycleBus.onAny(listener);
  });
  afterEach(() => {
    lifecycleBus.offAny(listener);
    rmSync(projectPath, { recursive: true, force: true });
    scratchProjects = [];
  });

  it("400s on malformed JSON", async () => {
    makeProposal(projectPath, "slug", "status: draft\n");
    const res = await handlePatchSpecStatus(
      "nx",
      "slug",
      new Request("http://test/", { method: "PATCH", body: "not-json" }),
    );
    expect(res.status).toBe(400);
  });

  it("400s on invalid status", async () => {
    makeProposal(projectPath, "slug", "status: draft\n");
    const res = await handlePatchSpecStatus(
      "nx",
      "slug",
      jsonRequest({ status: "shipped" }),
    );
    expect(res.status).toBe(400);
  });

  it("404s on unknown spec slug", async () => {
    const res = await handlePatchSpecStatus(
      "nx",
      "ghost",
      jsonRequest({ status: "approved" }),
    );
    expect(res.status).toBe(404);
  });

  it("flips draft→approved and writes approved-by + approved-at", async () => {
    const file = makeProposal(projectPath, "slug", "status: draft\n");
    const res = await handlePatchSpecStatus(
      "nx",
      "slug",
      jsonRequest({ status: "approved" }),
    );
    expect(res.status).toBe(200);
    const body = readFileSync(file, "utf8");
    expect(body).toMatch(/status: approved\n/);
    expect(body).toMatch(/approved-by: /);
    expect(body).toMatch(/approved-at: \d{4}-\d{2}-\d{2}T/);
    expect(busEvents.length).toBe(1);
  });

  it("flips approved→draft and strips approved-by + approved-at", async () => {
    const file = makeProposal(
      projectPath,
      "slug",
      "status: approved\napproved-by: leo@x.dev\napproved-at: 2026-05-21T00:00:00-05:00\n",
    );
    const res = await handlePatchSpecStatus(
      "nx",
      "slug",
      jsonRequest({ status: "draft" }),
    );
    expect(res.status).toBe(200);
    const body = readFileSync(file, "utf8");
    expect(body).toMatch(/status: draft\n/);
    expect(body).not.toMatch(/approved-by:/);
    expect(body).not.toMatch(/approved-at:/);
  });

  it("409s on archived specs", async () => {
    makeProposal(
      projectPath,
      "archived-slug",
      "status: approved\n",
      /* archived */ true,
    );
    const res = await handlePatchSpecStatus(
      "nx",
      "archived-slug",
      jsonRequest({ status: "draft" }),
    );
    expect(res.status).toBe(409);
  });

  it("404s when proposal.md is missing under a real spec dir", async () => {
    mkdirSync(join(projectPath, "openspec", "changes", "empty-slug"), {
      recursive: true,
    });
    const res = await handlePatchSpecStatus(
      "nx",
      "empty-slug",
      jsonRequest({ status: "approved" }),
    );
    expect(res.status).toBe(404);
  });
});
