/**
 * GET /wave-plans/active — projects the in-flight `/apply` or `/apply:all`
 * wave plan onto the dashboard wire shape.
 *
 * Added by `specs-tab-accordion-with-topology`. The handler reads
 * `<repoRoot>/docs/apply/active.txt` (single-line run-id pointer), then
 * loads `<repoRoot>/docs/apply/<run-id>/wave-plan.json` and flattens
 * `waves[].specs[]` into a single `specStatuses[]` array consumed by
 * the Swift dashboard.
 *
 * Contract decisions (see proposal § Locked Decisions):
 *   - Empty-state response always returns the FULL shape with nulls /
 *     empty array — downstream Codable parsers expect predictable keys.
 *   - Malformed wave plan returns 200 with an embedded `error` field
 *     (NOT 500). The dashboard degrades gracefully; a parse error is
 *     still a successful "I reached the file but couldn't read it"
 *     signal.
 *   - No caching — wave-plan.json is small and dashboard polling is rare.
 *
 * Repo-root resolution: the agent under systemd-user has CWD `/`, so we
 * accept `NEXUS_REPO_ROOT` as the canonical override. Fallback walks
 * `process.cwd()` upward looking for a `docs/apply/` directory, then
 * defaults to `<homedir>/dev/nx`.
 */

import { createLogger } from "@nexus/core/node";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

const log = createLogger("agent:routes:wave-plans");

// ---------------------------------------------------------------------------
// Wire shape — mirrors apps/swift/NexusShared/Models/WavePlanStatus.swift
// ---------------------------------------------------------------------------

export type WavePlanWireStatus =
  | "queued"
  | "dispatched"
  | "in_progress"
  | "completed"
  | "failed"
  | "skipped";

export interface SpecStatusWire {
  name: string;
  wave: number;
  status: WavePlanWireStatus;
  phase: string | null;
  dispatchedAt: string | null;
}

export interface WavePlanPayload {
  runId: string | null;
  planName: string | null;
  status: string | null;
  currentWave: number | null;
  currentPhase: string | null;
  specStatuses: SpecStatusWire[];
  /** Present only on malformed-JSON / read-error paths. */
  error?: string;
}

// ---------------------------------------------------------------------------
// Status normalization (Task 1.4)
// ---------------------------------------------------------------------------

const CANONICAL_STATUSES: ReadonlySet<WavePlanWireStatus> = new Set<WavePlanWireStatus>([
  "queued",
  "dispatched",
  "in_progress",
  "completed",
  "failed",
  "skipped",
]);

const LEGACY_ALIASES: Readonly<Record<string, WavePlanWireStatus>> = {
  // Older /apply telemetry used `pending` for "not yet dispatched" and `done`
  // for "merged". The canonical wire enum collapses those to queued/completed.
  pending: "queued",
  done: "completed",
  merged: "completed",
  // Some pipelines emit `error` instead of `failed`.
  error: "failed",
};

/**
 * Map an internal wave-plan status string onto the canonical wire enum.
 * Unknown values fall back to `queued` (the safest "not yet started" state).
 */
export function normalizeSpecStatus(raw: unknown): WavePlanWireStatus {
  if (typeof raw !== "string") return "queued";
  const lower = raw.toLowerCase();
  if (CANONICAL_STATUSES.has(lower as WavePlanWireStatus)) {
    return lower as WavePlanWireStatus;
  }
  if (lower in LEGACY_ALIASES) {
    return LEGACY_ALIASES[lower]!;
  }
  return "queued";
}

// ---------------------------------------------------------------------------
// Repo-root resolution
// ---------------------------------------------------------------------------

/**
 * Resolve the repository root that owns `docs/apply/`. Priority:
 *   1. `NEXUS_REPO_ROOT` env var (canonical override — set via `~/.env`,
 *      loaded through the unit's `EnvironmentFile=-%h/.env`, or the process
 *      environment; deploy/nexus-agent.service does NOT set it).
 *   2. Walk up from `process.cwd()` looking for `docs/apply/`.
 *   3. Fall back to `<homedir>/dev/nx`.
 *
 * Exported for tests so fixtures can pin the root.
 */
export function resolveRepoRoot(): string {
  const envRoot = process.env.NEXUS_REPO_ROOT;
  if (envRoot && envRoot.length > 0) return resolve(envRoot);

  // Walk up from cwd looking for a `docs/apply/` directory.
  let cur = process.cwd();
  for (let i = 0; i < 10; i++) {
    if (existsSync(join(cur, "docs", "apply"))) return cur;
    const parent = dirname(cur);
    if (parent === cur) break;
    cur = parent;
  }

  return join(homedir(), "dev", "nx");
}

// ---------------------------------------------------------------------------
// Wave plan projection
// ---------------------------------------------------------------------------

interface InternalSpec {
  name?: unknown;
  status?: unknown;
  phase_classification?: unknown;
  dispatched_at?: unknown;
}

interface InternalWave {
  wave_number?: unknown;
  specs?: unknown;
}

interface InternalWavePlan {
  plan_id?: unknown;
  plan_name?: unknown;
  status?: unknown;
  current_wave?: unknown;
  current_phase?: unknown;
  waves?: unknown;
}

/**
 * Build an empty-state payload. Every field is present so Codable parsers
 * on the Swift side don't need to handle missing-key cases.
 */
function emptyPayload(error?: string): WavePlanPayload {
  const payload: WavePlanPayload = {
    runId: null,
    planName: null,
    status: null,
    currentWave: null,
    currentPhase: null,
    specStatuses: [],
  };
  if (error !== undefined) payload.error = error;
  return payload;
}

/**
 * Project the raw wave-plan.json (Python /apply telemetry shape) onto the
 * wire shape consumed by the dashboard. Exported for tests.
 */
export function projectWavePlan(raw: unknown, runId: string): WavePlanPayload {
  if (raw === null || typeof raw !== "object") {
    return emptyPayload("wave-plan.json is not a JSON object");
  }
  const plan = raw as InternalWavePlan;

  const planName = typeof plan.plan_id === "string" ? plan.plan_id : runId;
  const status = typeof plan.status === "string" ? plan.status : null;
  const currentWave = typeof plan.current_wave === "number" ? plan.current_wave : null;
  const currentPhase = typeof plan.current_phase === "string" ? plan.current_phase : null;

  const specStatuses: SpecStatusWire[] = [];
  const waves = Array.isArray(plan.waves) ? (plan.waves as unknown[]) : [];
  for (const waveRaw of waves) {
    if (waveRaw === null || typeof waveRaw !== "object") continue;
    const wave = waveRaw as InternalWave;
    const waveNumber = typeof wave.wave_number === "number" ? wave.wave_number : 0;
    const specs = Array.isArray(wave.specs) ? (wave.specs as unknown[]) : [];
    for (const specRaw of specs) {
      if (specRaw === null || typeof specRaw !== "object") continue;
      const spec = specRaw as InternalSpec;
      const name = typeof spec.name === "string" ? spec.name : null;
      if (name === null) continue;
      specStatuses.push({
        name,
        wave: waveNumber,
        status: normalizeSpecStatus(spec.status),
        phase: typeof spec.phase_classification === "string" ? spec.phase_classification : null,
        dispatchedAt: typeof spec.dispatched_at === "string" ? spec.dispatched_at : null,
      });
    }
  }

  return {
    runId,
    planName,
    status,
    currentWave,
    currentPhase,
    specStatuses,
  };
}

// ---------------------------------------------------------------------------
// Filesystem read (exported for tests so they can stub via repo-root override)
// ---------------------------------------------------------------------------

/**
 * Read + project the active wave plan from the given repo root. Returns the
 * empty payload when `active.txt` is missing, and an error-embedded payload
 * when the JSON is malformed.
 */
export async function loadActiveWavePlan(repoRoot: string): Promise<WavePlanPayload> {
  const activeFile = join(repoRoot, "docs", "apply", "active.txt");
  let runId: string;
  try {
    const raw = await readFile(activeFile, "utf-8");
    runId = raw.trim();
    if (runId.length === 0) {
      return emptyPayload();
    }
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    if (e.code === "ENOENT") {
      // No active run — well-known empty state.
      return emptyPayload();
    }
    log.warn({ err, activeFile }, "failed to read active.txt");
    return emptyPayload(`failed to read active.txt: ${e.message ?? String(e)}`);
  }

  const planFile = join(repoRoot, "docs", "apply", runId, "wave-plan.json");
  let planRaw: string;
  try {
    planRaw = await readFile(planFile, "utf-8");
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    log.warn({ err, planFile, runId }, "failed to read wave-plan.json");
    return emptyPayload(`failed to read wave-plan.json: ${e.message ?? String(e)}`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(planRaw);
  } catch (err) {
    const e = err as Error;
    log.warn({ err, planFile, runId }, "wave-plan.json is malformed");
    return emptyPayload(`malformed wave-plan.json: ${e.message ?? String(e)}`);
  }

  return projectWavePlan(parsed, runId);
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

export async function handleGetActiveWavePlan(): Promise<Response> {
  const repoRoot = resolveRepoRoot();
  const payload = await loadActiveWavePlan(repoRoot);
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}
