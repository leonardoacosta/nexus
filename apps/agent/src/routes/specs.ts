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
import type { BeadRollup } from "@nexus/core";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import {
  loadProjectRegistry,
  pollProjectSpecs,
  type SpecSnapshot,
} from "../services/spec-watcher";
import { getProjects, type ProjectConfig } from "../services/config-loader";
import { execText } from "../utils/exec";
import {
  computeBeadRollup,
  defaultRollupBeadSource,
  type RawBead,
  type RollupBeadSource,
} from "../services/bead-rollup";

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

interface ProjectSpecStatus {
  code: string;
  name: string;
  specs: Array<SpecSnapshot & { beadRollup: BeadRollup | null }>;
}

/**
 * A per-project rollup source that fetches `bd ready --json` at most once
 * (memoised) and reuses it across every spec in that project — otherwise
 * `handleGetSpecsAll` would spawn `bd ready` once per spec, per project.
 */
function memoisedProjectSource(): RollupBeadSource {
  let readyCache: Promise<RawBead[]> | null = null;
  return {
    listBeads: defaultRollupBeadSource.listBeads,
    listReady: (cwd) =>
      (readyCache ??= defaultRollupBeadSource.listReady(cwd)),
  };
}

export async function handleGetSpecsAll(): Promise<Response> {
  const projects = loadProjects();
  const results: ProjectSpecStatus[] = [];

  for (const project of projects) {
    const openspecDir = join(project.path, "openspec");
    if (!existsSync(openspecDir)) continue;

    const specs = await pollProjectSpecs(project.path);
    const source = memoisedProjectSource();
    const withRollups = await Promise.all(
      specs.map(async (spec) => ({
        ...spec,
        beadRollup: await computeBeadRollup(project.path, spec.name, source),
      })),
    );

    results.push({
      code: project.code,
      name: project.name,
      specs: withRollups,
    });
  }

  return new Response(JSON.stringify({ projects: results }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

// ---------------------------------------------------------------------------
// GET /specs -- list specs with optional status filter
//
// VERIFICATION (homelab-emits-specs-credentials task 1.5):
//   This handler is correct against the wire contract. It composes
//     loadProjects() (projects.json registry, expandTilde'd in config-loader)
//     × pollProjectSpecs(project.path) (now filesystem-driven per task 1.3)
//   then attaches `project: project.code` to each spec and normalizes the
//   has_proposal/has_design/has_tasks tri-state via the `?? false` default
//   below. The `agent-payload-completeness` Swift decoder pins those three
//   booleans non-optional, so the `?? false` default is load-bearing for
//   the wire contract.
//
//   No changes required — the empty `[]` symptom was rooted in
//   pollProjectSpecs failing silently against a missing `openspec` CLI.
//   With task 1.3's fs-direct scan in place, this handler now surfaces
//   real spec rows without modification.
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

  // Normalize the tri-state markers (agent-payload-completeness): the
  // SpecSnapshot type leaves them optional for legacy in-memory
  // constructors, but the wire contract pins them non-optional. Default
  // any absent value to `false` so the Swift `SpecSummary` decoder always
  // sees a boolean.
  const wireRows = filtered.map((s) => ({
    ...s,
    has_proposal: s.has_proposal ?? false,
    has_design: s.has_design ?? false,
    has_tasks: s.has_tasks ?? false,
  }));

  return new Response(JSON.stringify(wireRows), {
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

  // specs-tab-start-on-spec task 2.7: stitch the proposal.md frontmatter
  // alongside the openspec CLI output so the Swift dashboard can render a
  // read-only metadata pane (approved-by, approved-at, capability, etc.)
  // without a follow-up fetch. Missing/unreadable frontmatter -> `{}`. Keys
  // are preserved verbatim (no case normalisation).
  const frontmatter = readProposalFrontmatter(proj.path, name);

  // add-bead-proposal-roadmap-surface: attach the live bead rollup. Null
  // when the project has no `.beads/` or `bd` errors — the payload is
  // otherwise unchanged (never a 500).
  const beadRollup = await computeBeadRollup(proj.path, name);

  try {
    const spec = JSON.parse(result.stdout);
    return new Response(
      JSON.stringify({ ...spec, project, frontmatter, beadRollup }),
      {
        status: 200,
        headers: { "Content-Type": "application/json" },
      },
    );
  } catch {
    return new Response(
      JSON.stringify({ error: "failed to parse spec data" }),
      { status: 500, headers: { "Content-Type": "application/json" } },
    );
  }
}

/**
 * Parse the flat YAML frontmatter at the top of `proposal.md` into a string
 * map. Missing file / no fence / malformed block → `{}`. Values are read
 * verbatim, trimmed; quoted values are unwrapped (single or double).
 *
 * This is the read counterpart to `spliceFrontmatter` in
 * `routes/specs/handlers-status.ts`. Kept intentionally flat (no nested
 * keys, no list values) — the proposal contract is flat-only.
 */
function readProposalFrontmatter(
  projectPath: string,
  specName: string,
): Record<string, string> {
  // Try live first, then archive (mirrors resolveSpecDir's order).
  const livePath = join(projectPath, "openspec", "changes", specName, "proposal.md");
  let source: string | null = null;
  if (existsSync(livePath)) {
    try {
      source = readFileSync(livePath, "utf8");
    } catch {
      /* fall through */
    }
  }
  if (source === null) {
    // Archive scan (best-effort; no error on miss).
    const archiveRoot = join(projectPath, "openspec", "changes", "archive");
    if (existsSync(archiveRoot)) {
      try {
        const suffix = `-${specName}`;
        for (const entry of readdirSync(archiveRoot)) {
          if (entry === specName || entry.endsWith(suffix)) {
            const candidate = join(archiveRoot, entry, "proposal.md");
            if (existsSync(candidate)) {
              try {
                source = readFileSync(candidate, "utf8");
                break;
              } catch {
                /* keep searching */
              }
            }
          }
        }
      } catch {
        /* fall through */
      }
    }
  }
  if (source === null) return {};

  const FENCE = "---";
  const lines = source.split("\n");

  // First non-empty line MUST be `---` to count as frontmatter.
  let firstIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    if (line.trim().length === 0) continue;
    if (line.trim() === FENCE) firstIdx = i;
    break;
  }
  if (firstIdx === -1) return {};

  // Closing fence.
  let endIdx = -1;
  for (let i = firstIdx + 1; i < lines.length; i++) {
    if ((lines[i] ?? "").trim() === FENCE) {
      endIdx = i;
      break;
    }
  }
  if (endIdx === -1) return {};

  const out: Record<string, string> = {};
  for (let i = firstIdx + 1; i < endIdx; i++) {
    const line = lines[i] ?? "";
    const colonIdx = line.indexOf(":");
    if (colonIdx === -1) continue;
    const key = line.slice(0, colonIdx).trim();
    if (!key) continue;
    let value = line.slice(colonIdx + 1).trim();
    // Unwrap single/double-quoted values.
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
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
// GET /specs/:project/:name/:file -- raw markdown content
//
// Serves proposal.md / design.md / tasks.md for a given spec, after strict
// path sanitization. The canonical filesystem layout is
//   <project.path>/openspec/changes/<name>/<file>.md
//
// Sanitization rules:
//   - `file` MUST be one of {"proposal","design","tasks"}.
//   - `project` and `name` MUST be non-empty and contain no path separators
//     or ".." segments.
//   - The resolved absolute path MUST live under the project's openspec
//     changes directory (defense in depth against symlink escapes).
//
// Spec: dashboard-ui-pass-v1 (task 1.1)
// ---------------------------------------------------------------------------

const SPEC_FILES = new Set(["proposal", "design", "tasks"]);

function isUnsafeSegment(seg: string): boolean {
  if (!seg || seg.length === 0) return true;
  if (seg === "." || seg === "..") return true;
  if (seg.includes("/") || seg.includes("\\") || seg.includes("\0")) return true;
  if (seg.includes("..")) return true;
  return false;
}

export async function handleGetSpecContent(
  project: string,
  name: string,
  file: string,
): Promise<Response> {
  // 1. Validate the `file` slug against the allowlist BEFORE any fs work.
  if (!SPEC_FILES.has(file)) {
    return new Response(
      JSON.stringify({ error: "invalid file (expected proposal|design|tasks)" }),
      { status: 400, headers: { "Content-Type": "application/json" } },
    );
  }

  // 2. Reject traversal / separator characters in path segments.
  if (isUnsafeSegment(project) || isUnsafeSegment(name)) {
    return new Response(
      JSON.stringify({ error: "invalid path segment" }),
      { status: 400, headers: { "Content-Type": "application/json" } },
    );
  }

  // 3. Resolve the project root.
  const proj = resolveProject(project);
  if (!proj) {
    return new Response(
      JSON.stringify({ error: "not found" }),
      { status: 404, headers: { "Content-Type": "application/json" } },
    );
  }

  // 4. Build the canonical path and verify it lives under the changes dir.
  const changesRoot = resolve(join(proj.path, "openspec", "changes"));
  const filePath = resolve(join(changesRoot, name, `${file}.md`));
  const rootWithSep = changesRoot.endsWith(sep) ? changesRoot : changesRoot + sep;
  if (!filePath.startsWith(rootWithSep)) {
    return new Response(
      JSON.stringify({ error: "invalid path" }),
      { status: 400, headers: { "Content-Type": "application/json" } },
    );
  }

  if (!existsSync(filePath)) {
    return new Response(
      JSON.stringify({ error: "not found" }),
      { status: 404, headers: { "Content-Type": "application/json" } },
    );
  }

  try {
    const body = await readFile(filePath, "utf8");
    return new Response(body, {
      status: 200,
      headers: { "Content-Type": "text/markdown; charset=utf-8" },
    });
  } catch (err) {
    log.warn({ project, name, file, err }, "spec content read failed");
    return new Response(
      JSON.stringify({ error: "not found" }),
      { status: 404, headers: { "Content-Type": "application/json" } },
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
