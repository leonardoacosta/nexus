/**
 * Project detail routes — status, beads, git, specs, run command.
 *
 * Each route resolves a project code to its filesystem path using
 * the projects registry (~/.claude/scripts/config/projects.json),
 * then shells out to the appropriate tool (bd, git, openspec).
 */

import { createLogger } from "@nexus/core";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { pollProjectSpecs } from "../services/spec-watcher";
import { getProjects, type ProjectConfig } from "../services/config-loader";
import { execText } from "../utils/exec";

const log = createLogger("agent:routes:project-detail");

// ---------------------------------------------------------------------------
// Project registry
// ---------------------------------------------------------------------------

function resolveProject(code: string): ProjectConfig | null {
  return getProjects().find((p) => p.code === code) ?? null;
}

// ---------------------------------------------------------------------------
// Subprocess helpers
// ---------------------------------------------------------------------------

async function spawnWithTimeout(
  cmd: string[],
  cwd: string,
): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  try {
    const stdout = await execText(cmd[0]!, cmd.slice(1), { cwd });
    return { ok: true, stdout, stderr: "" };
  } catch (err) {
    return {
      ok: false,
      stdout: "",
      stderr: err instanceof Error ? err.message : String(err),
    };
  }
}

function projectNotFound(code: string): Response {
  return new Response(
    JSON.stringify({ error: `unknown project: ${code}` }),
    { status: 404, headers: { "Content-Type": "application/json" } },
  );
}

// ---------------------------------------------------------------------------
// GET /project/:code/status
// ---------------------------------------------------------------------------

export async function handleProjectStatus(
  code: string,
  url: URL,
): Promise<Response> {
  const project = resolveProject(code);
  if (!project) return projectNotFound(code);

  const fresh = url.searchParams.get("fresh") === "true";

  // Gather status from all sources in parallel.
  const [gitResult, specsResult, beadsResult] = await Promise.all([
    fetchGitStatus(project.path),
    pollProjectSpecs(project.path),
    fetchBeadsStatus(project.path),
  ]);

  const status = {
    code: project.code,
    name: project.name,
    path: project.path,
    fresh,
    git: gitResult,
    spec: {
      active_changes: specsResult.map((s) => s.name),
      specs: specsResult,
    },
    beads: beadsResult,
  };

  return new Response(JSON.stringify(status), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

// ---------------------------------------------------------------------------
// GET /project/:code/beads
// ---------------------------------------------------------------------------

export async function handleProjectBeads(
  code: string,
): Promise<Response> {
  const project = resolveProject(code);
  if (!project) return projectNotFound(code);

  const beads = await fetchBeadsStatus(project.path);

  return new Response(JSON.stringify(beads), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

// ---------------------------------------------------------------------------
// GET /project/:code/git
// ---------------------------------------------------------------------------

export async function handleProjectGit(
  code: string,
): Promise<Response> {
  const project = resolveProject(code);
  if (!project) return projectNotFound(code);

  const git = await fetchGitStatus(project.path);

  return new Response(JSON.stringify(git), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

// ---------------------------------------------------------------------------
// GET /project/:code/specs
// ---------------------------------------------------------------------------

export async function handleProjectSpecs(
  code: string,
): Promise<Response> {
  const project = resolveProject(code);
  if (!project) return projectNotFound(code);

  const specs = await pollProjectSpecs(project.path);
  const result = {
    active_changes: specs.map((s) => s.name),
    specs,
  };

  return new Response(JSON.stringify(result), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

// ---------------------------------------------------------------------------
// POST /project/:code/run
// ---------------------------------------------------------------------------

export async function handleRunCommand(
  code: string,
  request: Request,
): Promise<Response> {
  const project = resolveProject(code);
  if (!project) return projectNotFound(code);

  let body: { command: string; args?: string[] };
  try {
    body = (await request.json()) as { command: string; args?: string[] };
  } catch {
    return new Response(
      JSON.stringify({ error: "invalid JSON body" }),
      { status: 400, headers: { "Content-Type": "application/json" } },
    );
  }

  if (!body.command || typeof body.command !== "string") {
    return new Response(
      JSON.stringify({ error: "command is required" }),
      { status: 400, headers: { "Content-Type": "application/json" } },
    );
  }

  // Build the prompt string (for logging/returning).
  const args = body.args ?? [];
  const prompt = args.length > 0
    ? `/${body.command} ${args.join(" ")}`
    : `/${body.command}`;

  log.info({ project: code, command: body.command, args }, "run command accepted");

  return new Response(
    JSON.stringify({
      status: "accepted",
      project: code,
      command: body.command,
      prompt,
      note: "Command accepted for execution",
    }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

interface GitStatus {
  branch: string;
  dirty: boolean;
  ahead: number;
  behind: number;
  recent_commits: string[];
}

async function fetchGitStatus(cwd: string): Promise<GitStatus> {
  const defaultGit: GitStatus = {
    branch: "",
    dirty: false,
    ahead: 0,
    behind: 0,
    recent_commits: [],
  };

  if (!existsSync(join(cwd, ".git"))) return defaultGit;

  const [branchResult, statusResult, revListResult, logResult] = await Promise.all([
    spawnWithTimeout(["git", "branch", "--show-current"], cwd),
    spawnWithTimeout(["git", "status", "--porcelain"], cwd),
    spawnWithTimeout(
      ["git", "rev-list", "--left-right", "--count", "@{upstream}...HEAD"],
      cwd,
    ),
    spawnWithTimeout(["git", "log", "--oneline", "-10"], cwd),
  ]);

  const branch = branchResult.ok ? branchResult.stdout.trim() : "";
  const dirty = statusResult.ok ? statusResult.stdout.trim().length > 0 : false;

  let ahead = 0;
  let behind = 0;
  if (revListResult.ok) {
    const parts = revListResult.stdout.trim().split(/\s+/);
    if (parts.length === 2) {
      behind = parseInt(parts[0]!, 10) || 0;
      ahead = parseInt(parts[1]!, 10) || 0;
    }
  }

  const recentCommits = logResult.ok
    ? logResult.stdout.trim().split("\n").filter(Boolean)
    : [];

  return { branch, dirty, ahead, behind, recent_commits: recentCommits };
}

interface BeadsStatus {
  open_count: number;
  ready_count: number;
  items: unknown[];
}

async function fetchBeadsStatus(cwd: string): Promise<BeadsStatus> {
  const defaultBeads: BeadsStatus = { open_count: 0, ready_count: 0, items: [] };

  if (!existsSync(join(cwd, ".beads"))) return defaultBeads;

  const result = await spawnWithTimeout(["bd", "ready", "--json"], cwd);
  if (!result.ok) return defaultBeads;

  try {
    const items = JSON.parse(result.stdout);
    if (!Array.isArray(items)) return defaultBeads;

    return {
      open_count: items.length,
      ready_count: items.length,
      items,
    };
  } catch {
    return defaultBeads;
  }
}
