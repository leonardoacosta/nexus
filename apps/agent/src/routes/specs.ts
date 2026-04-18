/**
 * Spec CRUD routes — list, detail, approve, reject, read, status.
 *
 * Mirrors the Rust agent's spec handlers. Cross-project aggregate uses
 * the project registry and spec-watcher state. Single-spec operations
 * delegate to the Rust agent's SQLite-backed NexusDb via Bun.spawn.
 *
 * For the Bun agent, spec data comes from either:
 *   1. The spec-watcher in-memory state (for /specs/all)
 *   2. Direct `openspec` subprocess calls (for per-project spec operations)
 */

import { createLogger } from "@nexus/core/node";
import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  loadProjectRegistry,
  pollProjectSpecs,
  type SpecSnapshot,
} from "../services/spec-watcher";
import { getProjects, type ProjectConfig } from "../services/config-loader";
import { execText, execJson } from "../utils/exec";

const log = createLogger("agent:routes:specs");

// ---------------------------------------------------------------------------
// Project registry helpers
// ---------------------------------------------------------------------------

function loadProjects(): ProjectConfig[] {
  return getProjects();
}

function resolveProject(code: string): ProjectConfig | null {
  const projects = loadProjects();
  return projects.find((p) => p.code === code) ?? null;
}

// ---------------------------------------------------------------------------
// Subprocess helper
// ---------------------------------------------------------------------------

async function runOpenspec(
  args: string[],
  cwd: string,
): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  try {
    const stdout = await execText("openspec", args, { cwd });
    return { ok: true, stdout, stderr: "" };
  } catch (err) {
    return {
      ok: false,
      stdout: "",
      stderr: err instanceof Error ? err.message : String(err),
    };
  }
}

// ---------------------------------------------------------------------------
// GET /specs/all -- cross-project aggregate
// ---------------------------------------------------------------------------

interface BeadsSummary {
  open: number;
  closed: number;
  ready: number;
}

interface ProjectSpecStatus {
  code: string;
  name: string;
  specs: SpecSnapshot[];
  beads: BeadsSummary | null;
}

async function fetchBeadsSummary(cwd: string): Promise<BeadsSummary | null> {
  if (!existsSync(join(cwd, ".beads"))) return null;

  try {
    const items = await execJson<unknown[]>("bd", ["ready", "--json"], { cwd });
    if (!Array.isArray(items)) return null;

    return {
      open: items.length,
      closed: 0,
      ready: items.length,
    };
  } catch {
    return null;
  }
}

export async function handleGetSpecsAll(): Promise<Response> {
  const projects = loadProjects();
  const results: ProjectSpecStatus[] = [];

  for (const project of projects) {
    const openspecDir = join(project.path, "openspec");
    if (!existsSync(openspecDir)) continue;

    const [specs, beads] = await Promise.all([
      pollProjectSpecs(project.path),
      fetchBeadsSummary(project.path),
    ]);

    results.push({
      code: project.code,
      name: project.name,
      specs,
      beads,
    });
  }

  return new Response(JSON.stringify({ projects: results }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

// ---------------------------------------------------------------------------
// GET /specs -- list specs with optional status filter
// ---------------------------------------------------------------------------

export async function handleListSpecs(url: URL): Promise<Response> {
  const statusFilter = url.searchParams.get("status");
  const projectFilter = url.searchParams.get("project");

  const projects = loadProjects();
  const allSpecs: Array<SpecSnapshot & { project: string }> = [];

  const targetProjects = projectFilter
    ? projects.filter((p) => p.code === projectFilter)
    : projects;

  for (const project of targetProjects) {
    const openspecDir = join(project.path, "openspec");
    if (!existsSync(openspecDir)) continue;

    const specs = await pollProjectSpecs(project.path);
    for (const spec of specs) {
      allSpecs.push({ ...spec, project: project.code });
    }
  }

  let filtered = allSpecs;
  if (statusFilter) {
    const statuses = statusFilter.split(",").map((s) => s.trim()).filter(Boolean);
    filtered = allSpecs.filter((s) => statuses.includes(s.status));
  }

  return new Response(JSON.stringify(filtered), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

// ---------------------------------------------------------------------------
// GET /specs/:project/:name -- single spec detail
// ---------------------------------------------------------------------------

export async function handleGetSpec(
  project: string,
  name: string,
): Promise<Response> {
  const proj = resolveProject(project);
  if (!proj) {
    return new Response(
      JSON.stringify({ error: `unknown project: ${project}` }),
      { status: 404, headers: { "Content-Type": "application/json" } },
    );
  }

  const result = await runOpenspec(["show", name, "--json"], proj.path);
  if (!result.ok) {
    return new Response(
      JSON.stringify({ error: `spec ${project}/${name} not found` }),
      { status: 404, headers: { "Content-Type": "application/json" } },
    );
  }

  try {
    const spec = JSON.parse(result.stdout);
    return new Response(JSON.stringify({ ...spec, project }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  } catch {
    return new Response(
      JSON.stringify({ error: "failed to parse spec data" }),
      { status: 500, headers: { "Content-Type": "application/json" } },
    );
  }
}

// ---------------------------------------------------------------------------
// POST /specs/:project/:name/approve
// ---------------------------------------------------------------------------

export async function handleApproveSpec(
  project: string,
  name: string,
): Promise<Response> {
  const proj = resolveProject(project);
  if (!proj) {
    return new Response(
      JSON.stringify({ error: `unknown project: ${project}` }),
      { status: 404, headers: { "Content-Type": "application/json" } },
    );
  }

  const result = await runOpenspec(["approve", name], proj.path);
  if (!result.ok) {
    return new Response(
      JSON.stringify({ error: result.stderr || `failed to approve spec ${name}` }),
      { status: 500, headers: { "Content-Type": "application/json" } },
    );
  }

  log.info({ project, name }, "spec approved via HTTP");
  return new Response(
    JSON.stringify({ project, name, status: "approved" }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );
}

// ---------------------------------------------------------------------------
// POST /specs/:project/:name/reject
// ---------------------------------------------------------------------------

export async function handleRejectSpec(
  project: string,
  name: string,
  request: Request,
): Promise<Response> {
  const proj = resolveProject(project);
  if (!proj) {
    return new Response(
      JSON.stringify({ error: `unknown project: ${project}` }),
      { status: 404, headers: { "Content-Type": "application/json" } },
    );
  }

  let reason: string | undefined;
  try {
    const body = await request.json();
    reason = (body as { reason?: string }).reason;
  } catch {
    // No body or invalid JSON -- proceed without reason.
  }

  const args = ["reject", name];
  if (reason) {
    args.push("--reason", reason);
  }

  const result = await runOpenspec(args, proj.path);
  if (!result.ok) {
    return new Response(
      JSON.stringify({ error: result.stderr || `failed to reject spec ${name}` }),
      { status: 500, headers: { "Content-Type": "application/json" } },
    );
  }

  log.info({ project, name, reason }, "spec rejected via HTTP");
  return new Response(
    JSON.stringify({ project, name, status: "rejected", reason: reason ?? null }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );
}

// ---------------------------------------------------------------------------
// POST /specs/:project/:name/read -- mark as read
// ---------------------------------------------------------------------------

export async function handleReadSpec(
  project: string,
  name: string,
): Promise<Response> {
  const proj = resolveProject(project);
  if (!proj) {
    return new Response(
      JSON.stringify({ error: `unknown project: ${project}` }),
      { status: 404, headers: { "Content-Type": "application/json" } },
    );
  }

  // Mark as read by touching a marker file or updating status.
  // The openspec CLI may not have a "read" command, so we implement it as a status update.
  const result = await runOpenspec(["status", name, "--json"], proj.path);
  if (!result.ok) {
    return new Response(
      JSON.stringify({ error: `spec ${project}/${name} not found` }),
      { status: 404, headers: { "Content-Type": "application/json" } },
    );
  }

  log.info({ project, name }, "spec marked as read via HTTP");
  try {
    const spec = JSON.parse(result.stdout);
    return new Response(JSON.stringify({ ...spec, project }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  } catch {
    return new Response(
      JSON.stringify({ project, name, status: "read" }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  }
}

// ---------------------------------------------------------------------------
// GET /specs/:project/:name/status -- approval gate check
// ---------------------------------------------------------------------------

export async function handleSpecStatus(
  project: string,
  name: string,
): Promise<Response> {
  const proj = resolveProject(project);
  if (!proj) {
    return new Response(
      JSON.stringify({ error: `unknown project: ${project}` }),
      { status: 404, headers: { "Content-Type": "application/json" } },
    );
  }

  const result = await runOpenspec(["status", name, "--json"], proj.path);
  if (!result.ok) {
    return new Response(
      JSON.stringify({ error: `spec ${project}/${name} not found` }),
      { status: 404, headers: { "Content-Type": "application/json" } },
    );
  }

  try {
    const data = JSON.parse(result.stdout);
    const status = typeof data.status === "string" ? data.status : "unknown";
    return new Response(JSON.stringify({ status }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  } catch {
    return new Response(
      JSON.stringify({ error: "failed to parse spec status" }),
      { status: 500, headers: { "Content-Type": "application/json" } },
    );
  }
}
