/**
 * /notifications/voices — per-project ElevenLabs voice overrides.
 *
 * Spec: openspec/changes/notifications-overhaul (task 2.7)
 *
 * Endpoints:
 *   GET    /notifications/voices            -> { project -> voiceId }
 *   PUT    /notifications/voices/:project   { voice_id }
 *   DELETE /notifications/voices/:project
 *
 * Write paths emit a `VoiceOverrideChanged` event on the lifecycle bus
 * AFTER the DB write commits — long-lived TTSObserver instances refresh
 * their cache via SSE without polling.
 */

import type { Db } from "@nexus/db";
import { projectVoiceOverrides } from "@nexus/db";
import { eq } from "drizzle-orm";
import { createLogger } from "@nexus/core/node";
import { lifecycleBus } from "../services/lifecycle-bus";

const log = createLogger("agent:routes:notifications-voices");

const PROJECT_RE = /^[A-Za-z0-9._-]+$/;
const VOICE_ID_MAX = 100;

function jsonResponse(data: unknown, status: number = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/**
 * GET /notifications/voices — return the full mapping as
 * `{ "<project>": "<voiceId>", ... }`. Empty object on no rows.
 */
export async function handleListVoices(db: Db): Promise<Response> {
  try {
    const rows = await db.select().from(projectVoiceOverrides);
    const payload: Record<string, string> = {};
    for (const r of rows) {
      payload[r.project] = r.voiceId;
    }
    return jsonResponse(payload, 200);
  } catch (err) {
    log.error(
      { err: err instanceof Error ? err.message : String(err) },
      "GET /notifications/voices failed",
    );
    return jsonResponse({ error: "failed to list voices" }, 500);
  }
}

/**
 * PUT /notifications/voices/:project — upsert a project voice override.
 * Body: `{ "voice_id": "<elevenlabs id>" }`.
 * Returns 200 with the persisted row.
 */
export async function handlePutVoice(
  db: Db,
  project: string,
  request: Request,
): Promise<Response> {
  if (!PROJECT_RE.test(project)) {
    return jsonResponse({ error: "invalid project slug" }, 400);
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return jsonResponse({ error: "invalid JSON body" }, 400);
  }

  const { voice_id } = (body ?? {}) as Record<string, unknown>;
  if (typeof voice_id !== "string" || voice_id.length === 0) {
    return jsonResponse(
      { error: "voice_id is required and must be a non-empty string" },
      400,
    );
  }
  if (voice_id.length > VOICE_ID_MAX) {
    return jsonResponse(
      { error: `voice_id exceeds ${VOICE_ID_MAX} characters` },
      400,
    );
  }

  const updatedAt = new Date();
  try {
    await db
      .insert(projectVoiceOverrides)
      .values({ project, voiceId: voice_id, updatedAt })
      .onConflictDoUpdate({
        target: projectVoiceOverrides.project,
        set: { voiceId: voice_id, updatedAt },
      });
  } catch (err) {
    log.error(
      { err: err instanceof Error ? err.message : String(err), project },
      "PUT /notifications/voices/:project failed",
    );
    return jsonResponse({ error: "failed to upsert voice override" }, 500);
  }

  // Emit AFTER the DB write commits.
  lifecycleBus.emit("VoiceOverrideChanged", { project });

  return jsonResponse(
    { project, voice_id, updated_at: updatedAt.toISOString() },
    200,
  );
}

/**
 * DELETE /notifications/voices/:project — drop the override.
 * Returns 204 on success (idempotent — missing row is still 204).
 */
export async function handleDeleteVoice(
  db: Db,
  project: string,
): Promise<Response> {
  if (!PROJECT_RE.test(project)) {
    return jsonResponse({ error: "invalid project slug" }, 400);
  }

  try {
    await db
      .delete(projectVoiceOverrides)
      .where(eq(projectVoiceOverrides.project, project));
  } catch (err) {
    log.error(
      { err: err instanceof Error ? err.message : String(err), project },
      "DELETE /notifications/voices/:project failed",
    );
    return jsonResponse({ error: "failed to delete voice override" }, 500);
  }

  lifecycleBus.emit("VoiceOverrideChanged", { project });

  return new Response(null, { status: 204 });
}
