/**
 * GET /specs/:project/:name/sessions — list every session linked to a spec.
 *
 * Spec: openspec/changes/specs-tab-start-on-spec § Endpoint Wiring.
 *
 * Joins `spec_sessions` LEFT against the live `sessions` registry so each row
 * carries an `active` boolean derived from "the linked session row still
 * exists and is not yet ended". Ordered newest-first by `created_at`.
 *
 * 404s when the spec slug resolves to neither a live `openspec/changes/<slug>/`
 * nor an archived `openspec/changes/archive/*-<slug>/` directory (i.e. the
 * caller asked about a spec the agent has never seen).
 */

import type { Db } from "@nexus/db";
import { specSessions, sessions, and, eq, desc, sql } from "@nexus/db";
import { resolveSpecDir } from "../../services/session-spec-link";
import { createLogger } from "@nexus/core/node";

const log = createLogger("agent:routes:specs:handlers-sessions");

export interface SpecSessionLinkRow {
  id: number;
  session_id: string;
  created_at: string;
  active: boolean;
}

export interface SpecSessionLinksResponse {
  sessions: SpecSessionLinkRow[];
}

export async function handleListSpecSessions(
  db: Db,
  project: string,
  specName: string,
): Promise<Response> {
  // Spec-existence gate: 404 if the slug doesn't resolve to a real spec
  // directory (live OR archive). Matches the proposal's "spec not found"
  // contract — archived specs ARE still considered valid targets.
  const specDir = resolveSpecDir(project, specName);
  if (!specDir) {
    return new Response(
      JSON.stringify({ error: "spec not found" }),
      { status: 404, headers: { "Content-Type": "application/json" } },
    );
  }

  let rows: Array<{
    id: number;
    sessionId: string;
    createdAt: Date;
    active: boolean;
  }>;
  try {
    rows = await db
      .select({
        id: specSessions.id,
        sessionId: specSessions.sessionId,
        createdAt: specSessions.createdAt,
        // `active` is true iff the linked session row still exists AND
        // `ended_at` is null. The LEFT JOIN can yield a null `sessions.id`
        // when the session was purged from the registry; in that case the
        // row is historical-only and `active` is false.
        active: sql<boolean>`(${sessions.id} IS NOT NULL AND ${sessions.endedAt} IS NULL)`,
      })
      .from(specSessions)
      .leftJoin(sessions, eq(sessions.id, specSessions.sessionId))
      .where(
        and(
          eq(specSessions.project, project),
          eq(specSessions.specName, specName),
        ),
      )
      .orderBy(desc(specSessions.createdAt));
  } catch (err) {
    log.error(
      {
        project,
        spec: specName,
        err: err instanceof Error ? err.message : String(err),
      },
      "spec sessions list query failed",
    );
    return new Response(
      JSON.stringify({ error: "internal error" }),
      { status: 500, headers: { "Content-Type": "application/json" } },
    );
  }

  const payload: SpecSessionLinksResponse = {
    sessions: rows.map((r) => ({
      id: r.id,
      session_id: r.sessionId,
      created_at: r.createdAt.toISOString(),
      // `sql<boolean>` from PG often comes back as 0/1 / "true"/"false";
      // normalise to a real boolean for the wire contract.
      active: Boolean(r.active),
    })),
  };

  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}
