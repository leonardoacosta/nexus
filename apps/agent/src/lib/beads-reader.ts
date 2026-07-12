/**
 * Fleet beads reader — whole-graph read of a single `.beads/` store.
 *
 * Adapted from BeadBoard's dual read path (Dolt SQL primary -> JSONL
 * fallback). Ported for nexus-agent's fleet-exceptions feed.
 *
 * ---------------------------------------------------------------------------
 * Attribution (MIT)
 *
 *   Portions of this file are adapted from BeadBoard:
 *     https://github.com/jordanhindo/beadboard
 *     (canonical upstream: https://github.com/zenchantlive/beadboard)
 *     Copyright (c) BeadBoard contributors. Licensed under the MIT License.
 *
 *   Specifically the read strategy from:
 *     - src/lib/read-issues-dolt.ts  (Dolt two-query whole-graph read;
 *       discovery via `.beads/metadata.json` + `.beads/dolt-server.port`)
 *     - src/lib/parser.ts            (issues.jsonl line parse + normalization)
 *
 *   This is a re-implementation, not a verbatim copy: nx runs Dolt in
 *   *embedded* mode (no sql-server), so the Dolt fast-path here activates
 *   ONLY when a `dolt-server.port` is discoverable and a MySQL-wire client
 *   is present; every nx store in practice resolves through the JSONL
 *   fallback. The MIT permission + attribution above is retained regardless.
 * ---------------------------------------------------------------------------
 *
 * Contract: `readBeadsStore` NEVER throws. A missing directory, absent
 * issues.jsonl, corrupt JSONL, or a failed Dolt connection all resolve to
 * `null` (unreadable) — the caller decides whether that is a skip. A store
 * that parses cleanly to zero issues resolves to `[]`, not `null`.
 */

import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { createLogger } from "@nexus/core/node";

const log = createLogger("agent:lib:beads-reader");

// ---------------------------------------------------------------------------
// Normalized bead shape (union of Dolt columns + JSONL fields we read)
// ---------------------------------------------------------------------------

/**
 * The subset of an issue's fields the fleet-exceptions computation needs.
 * Both read paths normalize into this camelCase shape so downstream code is
 * source-agnostic. Timestamps are kept as raw ISO-8601 strings (or null).
 */
export interface BeadRow {
  id: string;
  title: string;
  status: string;
  priority: number;
  issueType: string;
  createdAt: string | null;
  updatedAt: string | null;
  startedAt: string | null;
  closedAt: string | null;
  /** Number of things this issue depends on (its blockers), if known. */
  dependencyCount: number;
  labels: string[];
}

// ---------------------------------------------------------------------------
// Dolt discovery (mirrors BeadBoard read-issues-dolt.ts discovery)
// ---------------------------------------------------------------------------

export interface DoltDiscovery {
  database: string;
  port: number;
}

interface BeadsMetadata {
  dolt_database?: string;
  dolt_server_port?: number;
}

/**
 * Resolve the Dolt sql-server connection for a `.beads/` dir, or `null` when
 * none is discoverable (the embedded-mode case — nx's default). Prefers the
 * `.beads/dolt-server.port` sidecar file over the metadata.json port, exactly
 * as BeadBoard does. Never throws.
 */
export async function discoverDolt(
  beadsDir: string,
): Promise<DoltDiscovery | null> {
  try {
    const metaPath = join(beadsDir, "metadata.json");
    if (!existsSync(metaPath)) return null;

    let meta: BeadsMetadata;
    try {
      meta = JSON.parse(await readFile(metaPath, "utf8")) as BeadsMetadata;
    } catch {
      return null;
    }

    const database = meta.dolt_database;
    if (!database) return null;

    // Prefer the sidecar port file; fall back to metadata.json's port.
    let port: number | null = null;
    const portFile = join(beadsDir, "dolt-server.port");
    if (existsSync(portFile)) {
      const raw = (await readFile(portFile, "utf8")).trim();
      const parsed = Number.parseInt(raw, 10);
      if (Number.isFinite(parsed) && parsed > 0) port = parsed;
    }
    if (port === null && typeof meta.dolt_server_port === "number") {
      port = meta.dolt_server_port;
    }
    if (port === null) return null;

    return { database, port };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Dolt read path (BeadBoard's two-query whole-graph read)
// ---------------------------------------------------------------------------

/**
 * Minimal structural type for the MySQL-wire client we lazily load. Kept
 * local so nx does not take a hard `mysql2` dependency — the driver is only
 * needed when a real dolt sql-server is running (never in embedded mode).
 */
interface MysqlLike {
  createConnection(config: {
    host: string;
    port: number;
    user: string;
    database: string;
  }): Promise<{
    execute(sql: string): Promise<[unknown[], unknown]>;
    end(): Promise<void>;
  }>;
}

async function loadMysql(): Promise<MysqlLike | null> {
  // Non-literal specifier so tsc/bundlers do not statically resolve (and fail
  // on) a module that is intentionally not a declared dependency. If the
  // driver is absent the import rejects and we fall through to JSONL.
  const spec = "mysql2/promise";
  try {
    return (await import(spec)) as unknown as MysqlLike;
  } catch {
    return null;
  }
}

function toRowFromDolt(r: Record<string, unknown>): BeadRow {
  const str = (v: unknown): string => (typeof v === "string" ? v : "");
  const strOrNull = (v: unknown): string | null =>
    typeof v === "string" && v.length > 0 ? v : null;
  return {
    id: str(r.id),
    title: str(r.title),
    status: str(r.status),
    priority: typeof r.priority === "number" ? r.priority : Number(r.priority) || 0,
    issueType: str(r.issue_type),
    createdAt: strOrNull(r.created_at),
    updatedAt: strOrNull(r.updated_at),
    startedAt: strOrNull(r.started_at),
    closedAt: strOrNull(r.closed_at),
    dependencyCount:
      typeof r.dependency_count === "number"
        ? r.dependency_count
        : Number(r.dependency_count) || 0,
    labels:
      typeof r.labels_concat === "string" && r.labels_concat.length > 0
        ? r.labels_concat.split(",")
        : [],
  };
}

/**
 * Whole-graph read via a running Dolt sql-server (two flat queries, N+1-free
 * — BeadBoard's design). Returns `null` on any failure: no driver, unreachable
 * server, query error. Never throws.
 */
export async function readViaDolt(
  discovery: DoltDiscovery,
): Promise<BeadRow[] | null> {
  const mysql = await loadMysql();
  if (!mysql) return null;

  let conn: Awaited<ReturnType<MysqlLike["createConnection"]>> | null = null;
  try {
    conn = await mysql.createConnection({
      host: "127.0.0.1",
      port: discovery.port,
      user: "root",
      database: discovery.database,
    });
    // Query 1: issues + concatenated labels + dependency count (one shot).
    const [issueRows] = await conn.execute(
      `SELECT i.*,
              GROUP_CONCAT(l.label SEPARATOR ',') AS labels_concat,
              (SELECT COUNT(*) FROM dependencies d WHERE d.issue_id = i.id)
                AS dependency_count
       FROM issues i
       LEFT JOIN labels l ON l.issue_id = i.id
       GROUP BY i.id`,
    );
    if (!Array.isArray(issueRows)) return null;
    return issueRows.map((r) => toRowFromDolt(r as Record<string, unknown>));
  } catch (err) {
    log.warn({ err, port: discovery.port }, "dolt read failed; falling back");
    return null;
  } finally {
    if (conn) {
      try {
        await conn.end();
      } catch {
        /* ignore */
      }
    }
  }
}

// ---------------------------------------------------------------------------
// JSONL read path (BeadBoard's parser.ts — line parse + normalization)
// ---------------------------------------------------------------------------

interface RawJsonlIssue {
  _type?: string;
  id?: string;
  title?: string;
  status?: string;
  priority?: number;
  issue_type?: string;
  created_at?: string;
  updated_at?: string;
  started_at?: string;
  closed_at?: string;
  dependency_count?: number;
  labels?: string[];
}

function toRowFromJsonl(r: RawJsonlIssue): BeadRow | null {
  if (!r.id) return null;
  return {
    id: r.id,
    title: r.title ?? "",
    status: r.status ?? "unknown",
    priority: typeof r.priority === "number" ? r.priority : 0,
    issueType: r.issue_type ?? "unknown",
    createdAt: r.created_at ?? null,
    updatedAt: r.updated_at ?? null,
    startedAt: r.started_at ?? null,
    closedAt: r.closed_at ?? null,
    dependencyCount:
      typeof r.dependency_count === "number" ? r.dependency_count : 0,
    labels: Array.isArray(r.labels) ? r.labels : [],
  };
}

/**
 * Parse `.beads/issues.jsonl` line-by-line, tolerating malformed lines
 * (skipped, not fatal). Returns `null` when the file is unreadable OR when
 * the file has content but not a single line parsed to a valid issue (a
 * corrupt store — the caller skips it). A file that reads but is genuinely
 * empty (or all-blank) yields `[]`.
 */
export async function readViaJsonl(
  beadsDir: string,
): Promise<BeadRow[] | null> {
  const jsonlPath = join(beadsDir, "issues.jsonl");
  if (!existsSync(jsonlPath)) return null;

  let content: string;
  try {
    content = await readFile(jsonlPath, "utf8");
  } catch {
    return null;
  }

  const lines = content.split("\n");
  const rows: BeadRow[] = [];
  let sawNonBlank = false;
  let sawMalformed = false;

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    sawNonBlank = true;
    let parsed: RawJsonlIssue;
    try {
      parsed = JSON.parse(trimmed) as RawJsonlIssue;
    } catch {
      sawMalformed = true;
      continue;
    }
    // BeadBoard filters agent-identity beads and non-issue records at parse.
    if (parsed._type && parsed._type !== "issue") continue;
    const row = toRowFromJsonl(parsed);
    if (row) rows.push(row);
    else sawMalformed = true;
  }

  // Content present, nothing valid parsed -> corrupt store (skip signal).
  if (sawNonBlank && rows.length === 0 && sawMalformed) return null;
  return rows;
}

// ---------------------------------------------------------------------------
// Orchestrator — Dolt primary, JSONL fallback, null-not-throw
// ---------------------------------------------------------------------------

/**
 * Read a single `.beads/` store as normalized {@link BeadRow}s.
 *
 * Order: Dolt sql-server (when discoverable) -> issues.jsonl -> `null`.
 * Never throws. `null` means "no usable store here" (missing / corrupt /
 * unreachable); `[]` means "read cleanly, zero issues".
 */
export async function readBeadsStore(
  beadsDir: string,
): Promise<BeadRow[] | null> {
  try {
    if (!existsSync(beadsDir)) return null;

    const discovery = await discoverDolt(beadsDir);
    if (discovery) {
      const doltRows = await readViaDolt(discovery);
      if (doltRows !== null) return doltRows;
      // Dolt discoverable but read failed — fall through to JSONL.
    }

    return await readViaJsonl(beadsDir);
  } catch (err) {
    log.warn({ err, beadsDir }, "readBeadsStore failed; returning null");
    return null;
  }
}
