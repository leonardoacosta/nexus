/**
 * GET /projects/:code/pulse
 *
 * Companion to installfest's cc-tmux-nx-agent-roadmap-pulse spec (if-fz7h,
 * epic if-bqw): cc-tmux row3's `op:`/`bd:` counts used to read a local file
 * (`~/.claude/scripts/state/roadmap-pulse.<code>.line`) refreshed by a
 * nexus-statusline SWR spawn that was deleted (b8361e8c/2a6eda0c). This
 * endpoint lets cc-tmux fetch fresh counts from nx-agent directly instead.
 *
 * Computed NATIVELY here (Leo's explicit decision — no cross-repo shell-out
 * to cc's `roadmap-pulse` script), reusing the existing spec-watcher
 * (`pollProjectSpecs`, pure-fs, zero `openspec` CLI dependency) and
 * bead-watcher (`getBeadsForProject` via `cached-bead-source.ts`, zero
 * request-path `bd show` fan-out) infra this capability already has.
 *
 * Response shape is wire-compatible with cc-tmux's
 * `_parse_roadmap_pulse_counts` (installfest `apps/cc-tmux/src/cc_tmux/cli.py`)
 * — i.e. carries the same three numbers as `roadmap-pulse --line`'s
 * abbreviated `op:`/`bd:`/`next:` segments, just as structured JSON instead
 * of pre-rendered text:
 *
 *   op: { open, in_progress, ua, has_specs } — `ua` = closure debt (state
 *     "done" specs still live under openspec/changes/, i.e. done-but-
 *     unarchived — NOT the total-not-yet-archived count `/open` computes).
 *   bd: { open, ready, blocked } — STANDALONE bead counts only (beads that
 *     are NOT a transitive parent-child descendant of any
 *     `[SPEC]`/`[CAPABILITY]`-titled issue). This is the piece `GET /roadmap`
 *     does not compute — that route is capability-epic-scoped (epics ->
 *     proposals -> rollups), never a standalone-item count.
 *   next: optional pre-truncated next-action line, derived ONLY from the two
 *     data sources this endpoint already fetched (no radar/wave/TODO-ledger
 *     dependency — those live in cc's `roadmap-pulse` script and are out of
 *     scope for a native nx computation per the companion spec's Non-goals).
 *
 * Distinct from `GET /roadmap` (routes/roadmap.ts) — that route is
 * capability-epic-scoped and used by nexus-statusline's `getRoadmapLine`; do
 * not conflate the two. Read-only, fail-soft: an unavailable openspec/beads
 * source degrades its half to `null` rather than ever 500ing (mirrors
 * `computeRoadmap`'s degrade contract).
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import { createLogger } from "@nexus/core/node";
import { getProjects, type ProjectConfig } from "../services/config-loader";
import { pollProjectSpecs } from "../services/spec-watcher";
import type { SpecSnapshot } from "../services/spec-watcher";
import { getBeadsForProject } from "../services/cached-bead-source";
import { deriveBlockedIds, type RawBead } from "../services/bead-rollup";
import { withCors } from "../server-origin";

const log = createLogger("agent:routes:pulse");

// ---------------------------------------------------------------------------
// Wire types
// ---------------------------------------------------------------------------

export interface PulseOpenspec {
  open: number;
  in_progress: number;
  ua: number;
  has_specs: boolean;
}

export interface PulseBeads {
  open: number;
  ready: number;
  blocked: number;
}

export interface ProjectPulse {
  op: PulseOpenspec | null;
  bd: PulseBeads | null;
  next: string | null;
}

// ---------------------------------------------------------------------------
// Standalone-bead classification (mirrors cc's roadmap-pulse `is_standalone`
// ancestor-walk, scripts/bin/roadmap-pulse in the cc config repo)
// ---------------------------------------------------------------------------

const SPEC_TITLE_PREFIXES = ["[SPEC]", "[CAPABILITY]"];
const MAX_ANCESTOR_HOPS = 10; // guard against a cyclic/self-referential parent chain

/**
 * A bead is standalone when no ancestor in its parent chain is a
 * `[SPEC]`/`[CAPABILITY]`-titled issue (a capability epic or its proposal-
 * tracking equivalent). Pure — no IO.
 */
export function isStandaloneBead(
  bead: RawBead,
  byId: Map<string, RawBead>,
): boolean {
  let parentId = bead.parent;
  const seen = new Set<string>();
  let hops = 0;
  while (parentId && hops < MAX_ANCESTOR_HOPS && !seen.has(parentId)) {
    seen.add(parentId);
    const parent = byId.get(parentId);
    if (!parent) break;
    const title = parent.title ?? "";
    if (SPEC_TITLE_PREFIXES.some((prefix) => title.startsWith(prefix))) {
      return false;
    }
    parentId = parent.parent;
    hops += 1;
  }
  return true;
}

const OPEN_BEAD_STATUSES = new Set(["open", "in_progress", "blocked"]);

/**
 * Standalone open/in_progress/blocked bead counts, non-epic only (excluding
 * capability epics matches cc's roadmap-pulse precedent: an unblocked
 * `[CAPABILITY]` epic is technically "ready" by bd's own model, which would
 * otherwise make `ready > open` look impossible on the rendered line).
 *
 * `ready`/`blocked` are derived purely from the fetched bead set via
 * `deriveBlockedIds` (bead-rollup.ts's own convention) — no separate `bd
 * ready`/`bd blocked` CLI call, consistent with this project's existing
 * "ready is derived, not CLI-sourced" rule.
 */
export function computeBeadsPulse(beads: RawBead[]): PulseBeads {
  const byId = new Map<string, RawBead>();
  for (const b of beads) byId.set(b.id, b);
  const blockedIds = deriveBlockedIds(beads);

  let open = 0;
  let ready = 0;
  let blocked = 0;
  for (const b of beads) {
    if (b.issue_type === "epic") continue;
    if (!b.status || !OPEN_BEAD_STATUSES.has(b.status)) continue;
    if (!isStandaloneBead(b, byId)) continue;
    open += 1;
    if (blockedIds.has(b.id)) {
      blocked += 1;
    } else {
      ready += 1;
    }
  }
  return { open, ready, blocked };
}

// ---------------------------------------------------------------------------
// OpenSpec state classification (mirrors cc's `openspec-status --no-enrich`
// classifier, scripts/bin/openspec-status: without a bd epic-status enrich
// pass, `done`/`in-progress`/`open` reduce to pure task-count arithmetic —
// exactly what spec-watcher's SpecSnapshot already carries, no `bd` call
// needed)
// ---------------------------------------------------------------------------

type SpecState = "open" | "in-progress" | "done";

function classifySpecState(completed: number, total: number): SpecState {
  if (total > 0 && completed === total) return "done";
  if (completed > 0) return "in-progress";
  return "open";
}

/**
 * `done` here means "state=done but still under openspec/changes/" — i.e.
 * closure debt (the `ua` bucket), NOT total-not-yet-archived (that's `/open`'s
 * differently-scoped total; see cc-w83ov.4's naming-collision writeup in
 * scripts/bin/roadmap-pulse).
 */
export function computeOpenspecPulse(specs: SpecSnapshot[]): PulseOpenspec {
  if (specs.length === 0) {
    return { open: 0, in_progress: 0, ua: 0, has_specs: false };
  }
  let open = 0;
  let inProgress = 0;
  let ua = 0;
  for (const s of specs) {
    switch (classifySpecState(s.completedTasks, s.totalTasks)) {
      case "done":
        ua += 1;
        break;
      case "in-progress":
        inProgress += 1;
        break;
      default:
        open += 1;
    }
  }
  return { open, in_progress: inProgress, ua, has_specs: true };
}

// ---------------------------------------------------------------------------
// "next" — cheap, native-only precedence (rungs derivable from data this
// endpoint already fetched; cc's radar/wave/TODO-ledger rungs are NOT
// available to a native nx computation and are intentionally out of scope)
// ---------------------------------------------------------------------------

const NEXT_TEXT_MAX = 28;
const NEXT_TEXT_TRUNCATE_AT = 25;

function truncateNextText(text: string): string {
  if (text.length <= NEXT_TEXT_MAX) return text;
  return `${text.slice(0, NEXT_TEXT_TRUNCATE_AT)}...`;
}

/**
 * 1. A P0/P1 ready (non-closed, non-blocked) bead — any issue type, lowest
 *    priority number wins, ties broken by id for determinism.
 * 2. Else the first closure-debt (state "done") spec — `"<slug> (archive)"`.
 * 3. Else `null`.
 */
export function computeNextLine(
  beads: RawBead[],
  specs: SpecSnapshot[],
): string | null {
  const blockedIds = deriveBlockedIds(beads);
  let critical: RawBead | null = null;
  for (const b of beads) {
    if (!b.status || b.status === "closed" || blockedIds.has(b.id)) continue;
    if (typeof b.priority !== "number" || b.priority > 1) continue;
    if (
      !critical ||
      b.priority < critical.priority! ||
      (b.priority === critical.priority && b.id < critical.id)
    ) {
      critical = b;
    }
  }
  if (critical) {
    return truncateNextText(critical.title ?? critical.id);
  }

  const closureDebt = specs.find(
    (s) => classifySpecState(s.completedTasks, s.totalTasks) === "done",
  );
  if (closureDebt) {
    return truncateNextText(`${closureDebt.name} (archive)`);
  }

  return null;
}

// ---------------------------------------------------------------------------
// Route
// ---------------------------------------------------------------------------

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function defaultResolveProject(code: string): ProjectConfig | null {
  return getProjects().find((p) => p.code === code) ?? null;
}

/** Test seams — default to the live sources. */
export interface PulseRouteDeps {
  resolveProject?: (code: string) => ProjectConfig | null;
  pollSpecs?: (path: string) => Promise<SpecSnapshot[]>;
  listBeads?: (path: string) => Promise<RawBead[]>;
}

export async function handleGetProjectPulse(
  code: string,
  deps: PulseRouteDeps = {},
): Promise<Response> {
  const resolveProject = deps.resolveProject ?? defaultResolveProject;
  const proj = resolveProject(code);
  if (!proj) {
    return jsonResponse({ error: `unknown project: ${code}` }, 404);
  }

  const pollSpecs = deps.pollSpecs ?? pollProjectSpecs;
  const listBeads = deps.listBeads ?? getBeadsForProject;

  let specs: SpecSnapshot[] = [];
  let openspec: PulseOpenspec | null = null;
  if (existsSync(join(proj.path, "openspec"))) {
    try {
      specs = await pollSpecs(proj.path);
      openspec = computeOpenspecPulse(specs);
    } catch (err) {
      log.warn({ project: code, err }, "pulse: pollSpecs failed; op omitted");
    }
  }

  let beads: RawBead[] = [];
  let bd: PulseBeads | null = null;
  if (existsSync(join(proj.path, ".beads"))) {
    try {
      beads = await listBeads(proj.path);
      bd = computeBeadsPulse(beads);
    } catch (err) {
      log.warn({ project: code, err }, "pulse: listBeads failed; bd omitted");
    }
  }

  const next = computeNextLine(beads, specs);

  const body: ProjectPulse = { op: openspec, bd, next };
  return jsonResponse(body);
}

/**
 * Match and handle `GET /projects/:code/pulse`. Returns a Response when the
 * URL matches, `null` when it does not (callers fall through). Same 4-segment
 * precise-match shape as `tryHandleGitEventsRoute` (routes/project-status.ts)
 * — `segments[3] === "pulse"` cannot collide with `status`/`git-events`.
 */
export function tryHandlePulseRoute(
  request: Request,
  url: URL,
): Promise<Response> | null {
  // ["", "projects", ":code", "pulse"]
  const segments = url.pathname.split("/");
  if (
    segments.length !== 4 ||
    segments[1] !== "projects" ||
    segments[3] !== "pulse"
  ) {
    return null;
  }
  const code = segments[2];
  if (!code || request.method !== "GET") return null;

  return handleGetProjectPulse(code)
    .then((r) => withCors(request, r))
    .catch((err) => {
      log.error({ route: `/projects/${code}/pulse`, method: "GET", err }, "route handler failed");
      return withCors(request, jsonResponse({ error: "internal error" }, 500));
    });
}
