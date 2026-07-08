/**
 * Browser REST client for the Nexus agent's Radar endpoints — the mx source
 * index (`GET /sources`) and the durable request-history feed (`GET /requests`).
 *
 * Both endpoints are thin passthroughs to the mx gateway (see
 * `apps/agent/src/routes/sources.ts` + `requests.ts`). The agent FAIL-SOFTS: a
 * down/unreachable gateway yields `{ sources: [], inbox: [] }` / `{ requests: [] }`
 * with HTTP 200, so the web UI degrades to a named empty state rather than an
 * error or an infinite spinner.
 *
 * Like `agent-rest-client.ts`, this module defines its OWN browser DTOs and maps
 * the gateway's snake_case wire keys to camelCase — the web app does NOT depend
 * on `@nexus/core`/`@nexus/db` (those are server-only and would pull Drizzle/zod
 * into the browser bundle). The DTOs cover the fields the Radar UI needs; extra
 * wire keys are ignored. Field names mirror `SourceStatus.swift`.
 */

import { toHttpUrl } from "./agent-config";
import { AgentHttpError } from "./agent-rest-client";

// ── DTOs ─────────────────────────────────────────────────────────────────────

export type SourceHealth = "SERVING" | "DEGRADED" | "NOT_SERVING" | "UNKNOWN";

/** A source is degraded/down when not actively SERVING. Drives the row's visual distinction. */
export function isUnhealthy(health: SourceHealth): boolean {
  return health === "DEGRADED" || health === "NOT_SERVING";
}

/** One source in the mx registry fan-out — the camelCase mirror of the gateway row. */
export interface RadarSource {
  /** Stable registry slug — "teams", "ado", "gmail", … . Identity + toggle key. */
  id: string;
  /** Human display name — falls back to `id`. */
  displayName: string;
  /** Produced item kind — "EMAIL", "WORK_ITEM", … (nullable). */
  producesKind: string | null;
  /** registry.Aggregated() membership. */
  inAggregate: boolean;
  /** Serving health (SERVING / DEGRADED / NOT_SERVING / UNKNOWN). */
  health: SourceHealth;
  /** Human reason when degraded/down (e.g. "token expires in 2d"), else null. */
  healthReason: string | null;
  /** ISO timestamp of last sync, or null. */
  lastSyncAt: string | null;
  /** Total item count, or null when down. */
  itemCount: number | null;
  /** MINE (ball-in-court) subset count. */
  mineCount: number;
  canSearch: boolean;
  canStream: boolean;
}

/** The full `/sources` payload. `inbox` is carried but the Radar panel renders rows off `sources`. */
export interface SourceIndex {
  sources: RadarSource[];
}

// ── Fleet exceptions DTOs (add-fleet-exceptions-feed) ────────────────────────

/** Fleet-wide beads/backlog exception class (mirrors the agent's FleetExceptionClass). */
export type FleetExceptionClass =
  | "p0_open"
  | "p1_open"
  | "in_progress_stale"
  | "ready_head_stale"
  | "unarchived_changes";

/** Human label for each exception class — used in the /radar row lines. */
export const FLEET_EXCEPTION_LABEL: Record<FleetExceptionClass, string> = {
  p0_open: "P0 open",
  p1_open: "P1 open",
  in_progress_stale: "in-progress stale",
  ready_head_stale: "ready head stale",
  unarchived_changes: "unarchived changes",
};

/**
 * One (repo, class) exception line. Wire shape is ALREADY camelCase — the agent
 * serializes its `FleetExceptionEntry` directly — so unlike the source rows there
 * is no snake_case remap. `offenders` is capped agent-side (worst-first ids).
 */
export interface FleetExceptionEntry {
  repo: string;
  class: FleetExceptionClass;
  count: number;
  offenders: string[];
}

const FLEET_EXCEPTION_CLASSES: readonly FleetExceptionClass[] = [
  "p0_open",
  "p1_open",
  "in_progress_stale",
  "ready_head_stale",
  "unarchived_changes",
];

function toExceptionClass(v: unknown): FleetExceptionClass | null {
  return typeof v === "string" &&
    (FLEET_EXCEPTION_CLASSES as readonly string[]).includes(v)
    ? (v as FleetExceptionClass)
    : null;
}

/** Map one exception entry (tolerant of missing/extra keys); null when unusable. */
export function parseFleetException(raw: unknown): FleetExceptionEntry | null {
  if (typeof raw !== "object" || raw === null) return null;
  const r = raw as Record<string, unknown>;
  const repo = asString(r.repo);
  const cls = toExceptionClass(r.class);
  if (!repo || !cls) return null;
  const offenders = Array.isArray(r.offenders)
    ? r.offenders.filter((o): o is string => typeof o === "string")
    : [];
  return {
    repo,
    class: cls,
    count: asNumber(r.count) ?? offenders.length,
    offenders,
  };
}

/**
 * Parse the bare `/exceptions` JSON array. A clean fleet is `[]` (the
 * load-bearing silent-when-clean signal); a non-array (fail-soft) is also `[]`.
 */
export function parseFleetExceptions(raw: unknown): FleetExceptionEntry[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map(parseFleetException)
    .filter((e): e is FleetExceptionEntry => e !== null);
}

/** One request-status transition for a source (title, old -> new, timestamp). */
export interface RequestTransition {
  id: string;
  title: string;
  source: string | null;
  /** The field that flipped (e.g. "disposition", "status"), or null. */
  field: string | null;
  oldValue: string | null;
  newValue: string | null;
  /** ISO timestamp of the transition, or null. */
  changedAt: string | null;
}

// ── Wire parsing (tolerant, snake_case -> camelCase) ─────────────────────────

function asString(v: unknown): string | null {
  return typeof v === "string" && v !== "" ? v : null;
}
function asNumber(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}
function asBool(v: unknown, fallback: boolean): boolean {
  return typeof v === "boolean" ? v : fallback;
}

function toHealth(v: unknown): SourceHealth {
  const raw = typeof v === "string" ? v.toUpperCase() : "";
  return raw === "SERVING" || raw === "DEGRADED" || raw === "NOT_SERVING"
    ? raw
    : "UNKNOWN";
}

/** Map one gateway source row (snake_case) to a {@link RadarSource}. */
export function parseSource(raw: unknown): RadarSource | null {
  if (typeof raw !== "object" || raw === null) return null;
  const r = raw as Record<string, unknown>;
  const id = asString(r.id);
  if (!id) return null;
  return {
    id,
    displayName: asString(r.display_name) ?? id,
    producesKind: asString(r.produces_kind),
    inAggregate: asBool(r.in_aggregate, true),
    health: toHealth(r.status),
    healthReason: asString(r.reason),
    lastSyncAt: asString(r.last_sync_at),
    itemCount: asNumber(r.item_count),
    mineCount: asNumber(r.mine_count) ?? 0,
    canSearch: asBool(r.can_search, false),
    canStream: asBool(r.can_stream, false),
  };
}

/** Parse a `{ sources: [...] }` payload; tolerant of missing/extra keys. */
export function parseSourceIndex(raw: unknown): SourceIndex {
  const sources =
    typeof raw === "object" && raw !== null && Array.isArray((raw as { sources?: unknown }).sources)
      ? ((raw as { sources: unknown[] }).sources
          .map(parseSource)
          .filter((s): s is RadarSource => s !== null))
      : [];
  return { sources };
}

/** Map one gateway request-transition row (snake_case) to a {@link RequestTransition}. */
export function parseTransition(raw: unknown, index: number): RequestTransition | null {
  if (typeof raw !== "object" || raw === null) return null;
  const r = raw as Record<string, unknown>;
  return {
    id: asString(r.id) ?? String(index),
    title: asString(r.title) ?? "(untitled request)",
    source: asString(r.source),
    field: asString(r.field),
    // Tolerant of a couple of plausible wire spellings for the transition pair.
    oldValue: asString(r.old_value) ?? asString(r.from),
    newValue: asString(r.new_value) ?? asString(r.to),
    changedAt: asString(r.changed_at) ?? asString(r.timestamp),
  };
}

/** Parse a `{ requests: [...] }` payload; tolerant of missing/extra keys. */
export function parseTransitions(raw: unknown): RequestTransition[] {
  if (typeof raw !== "object" || raw === null) return [];
  const arr = (raw as { requests?: unknown }).requests;
  if (!Array.isArray(arr)) return [];
  return arr
    .map((row, i) => parseTransition(row, i))
    .filter((t): t is RequestTransition => t !== null);
}

// ── Fetchers ─────────────────────────────────────────────────────────────────

/** Bound each Radar fetch so a hung agent socket can't pend the UI forever. */
const FETCH_TIMEOUT_MS = 10_000;

function http(base: string, path: string): string {
  const url = toHttpUrl(base, path);
  if (!url) throw new AgentHttpError(0, `unconstructable agent URL for ${path}`);
  return url;
}

async function getJson(
  base: string,
  path: string,
  signal?: AbortSignal,
): Promise<unknown> {
  const timeout = AbortSignal.timeout(FETCH_TIMEOUT_MS);
  const res = await fetch(http(base, path), {
    method: "GET",
    headers: { Accept: "application/json" },
    cache: "no-store",
    signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
  });
  if (!res.ok) {
    throw new AgentHttpError(res.status, `GET ${path} -> ${res.status}`);
  }
  return res.json();
}

/** `GET /sources` — the mx source index (fail-soft empty on gateway down). */
export async function fetchSources(
  agentBaseUrl: string,
  signal?: AbortSignal,
): Promise<SourceIndex> {
  return parseSourceIndex(await getJson(agentBaseUrl, "/sources", signal));
}

/** Options for {@link fetchRequests}. */
export interface FetchRequestsOptions {
  source?: string;
  /** ISO timestamp lower bound (`changed_since`). */
  changedSince?: string;
  signal?: AbortSignal;
}

/**
 * `GET /requests?source=&changed_since=` — recent request transitions. The
 * agent fail-softs to `{ requests: [] }` when the gateway (or the not-yet-
 * deployed request store) is unavailable, which the caller renders as a named
 * empty state.
 */
export async function fetchRequests(
  agentBaseUrl: string,
  opts: FetchRequestsOptions = {},
): Promise<RequestTransition[]> {
  const params = new URLSearchParams();
  if (opts.source) params.set("source", opts.source);
  if (opts.changedSince) params.set("changed_since", opts.changedSince);
  const qs = params.toString();
  const path = qs ? `/requests?${qs}` : "/requests";
  return parseTransitions(await getJson(agentBaseUrl, path, opts.signal));
}

/**
 * `GET /exceptions` — fleet-wide beads/backlog exceptions (add-fleet-exceptions-feed).
 * The agent fail-softs to `[]` (HTTP 200) when the read fails; a clean fleet is
 * also `[]`. Callers render NOTHING for an empty array (silent-when-clean).
 */
export async function fetchExceptions(
  agentBaseUrl: string,
  signal?: AbortSignal,
): Promise<FleetExceptionEntry[]> {
  return parseFleetExceptions(await getJson(agentBaseUrl, "/exceptions", signal));
}
