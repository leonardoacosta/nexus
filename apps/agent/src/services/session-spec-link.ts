/**
 * session-spec-link — bridge between POST /session/start and the
 * `spec_sessions` join table.
 *
 * Spec: openspec/changes/specs-tab-start-on-spec § Endpoint Wiring.
 *
 * Resolves a spec slug to a real spec directory (live `openspec/changes/<slug>/`
 * first, then `openspec/changes/archive/*-<slug>/` so archived specs can still
 * be linked for historical investigation), then inserts a `spec_sessions` row.
 *
 * The caller (POST /session/start) MUST treat link failures as non-fatal —
 * a thrown insert error never rolls back the tmux spawn. This service
 * returns a structured `{ linked, error? }` instead of throwing for the
 * "spec not found" case so the handler can branch cleanly without a
 * try/catch on validation logic.
 */

import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import type { Db } from "@nexus/db";
import { specSessions } from "@nexus/db";
import { createLogger } from "@nexus/core/node";
import { getProjects } from "./config-loader";

const log = createLogger("agent:services:session-spec-link");

export interface LinkSpecToSessionInput {
  db: Db;
  /** Project code (e.g. "nx") — matches `projects.json` registry. */
  project: string;
  /** Spec slug — directory name under `openspec/changes/` (live or archive). */
  specSlug: string;
  /** Session id (the tmux/CC session name returned by /session/start). */
  sessionId: string;
}

export interface LinkSpecToSessionResult {
  linked: boolean;
  error?: string;
  /** Resolved absolute spec dir, present when `linked` is true. */
  specDir?: string;
}

/**
 * Resolve `<projectCode>/<slug>` to an absolute spec directory.
 *
 * Order:
 *   1. `<projectPath>/openspec/changes/<slug>/`           (live)
 *   2. `<projectPath>/openspec/changes/archive/*-<slug>/` (archived; the
 *      archive convention prefixes the slug with a date — match by suffix.)
 *
 * Returns null when neither location exists. The slug is treated as an
 * opaque token; callers must validate it before invoking (callers in this
 * codebase already enforce no-traversal via path-segment regex on the
 * spec-routes layer, so this helper is conservative — it scans by
 * directory entry and rejects anything that escapes the changes root).
 */
export function resolveSpecDir(
  projectCode: string,
  specSlug: string,
): string | null {
  // Reject obvious traversal up front — defense in depth on top of the
  // route-level sanitiser (handleGetSpecContent).
  if (
    !projectCode ||
    !specSlug ||
    specSlug.includes("/") ||
    specSlug.includes("..") ||
    specSlug.includes("\0")
  ) {
    return null;
  }

  const project = getProjects().find((p) => p.code === projectCode);
  if (!project) return null;

  const live = join(project.path, "openspec", "changes", specSlug);
  try {
    if (existsSync(live) && statSync(live).isDirectory()) {
      return live;
    }
  } catch {
    /* fall through to archive lookup */
  }

  const archiveRoot = join(project.path, "openspec", "changes", "archive");
  if (!existsSync(archiveRoot)) return null;

  let entries: string[];
  try {
    entries = readdirSync(archiveRoot);
  } catch {
    return null;
  }

  // Archive convention: `<YYYY-MM-DD>-<slug>/` (the leading prefix varies but
  // the slug is always at the end). Match by trailing `-<slug>` so we don't
  // accept a partial prefix collision (e.g. slug "foo" must not match
  // "foo-bar").
  const suffix = `-${specSlug}`;
  for (const entry of entries) {
    if (entry === specSlug || entry.endsWith(suffix)) {
      const candidate = join(archiveRoot, entry);
      try {
        if (statSync(candidate).isDirectory()) {
          return candidate;
        }
      } catch {
        /* skip non-dir entries */
      }
    }
  }

  return null;
}

export async function linkSpecToSession(
  opts: LinkSpecToSessionInput,
): Promise<LinkSpecToSessionResult> {
  const specDir = resolveSpecDir(opts.project, opts.specSlug);
  if (!specDir) {
    log.warn(
      { project: opts.project, spec: opts.specSlug, session: opts.sessionId },
      "spec link skipped: spec not found",
    );
    return { linked: false, error: "spec not found" };
  }

  try {
    await opts.db.insert(specSessions).values({
      project: opts.project,
      specName: opts.specSlug,
      sessionId: opts.sessionId,
    });
    log.info(
      {
        project: opts.project,
        spec: opts.specSlug,
        session: opts.sessionId,
        specDir,
      },
      "spec linked to session",
    );
    return { linked: true, specDir };
  } catch (err) {
    log.error(
      {
        project: opts.project,
        spec: opts.specSlug,
        session: opts.sessionId,
        err: err instanceof Error ? err.message : String(err),
      },
      "spec link insert failed",
    );
    return { linked: false, error: "insert failed" };
  }
}
