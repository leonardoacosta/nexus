/**
 * ElevenLabs credential management routes.
 *
 * Mirrors the encryption-at-rest pattern from `routes/credentials.ts` but with
 * a much smaller surface — one row per agent, no pool, no leasing, no
 * per-credential events. The agent stores the API key encrypted with
 * AES-256-GCM (existing helpers from `credentials/encryption.ts`) and the
 * voice metadata (`voice_id`, `voice_name`) plain alongside it.
 *
 * Endpoints (all gated by the global `x-nexus-secret` middleware):
 *   GET    /elevenlabs/credentials       — masked status (NEVER returns the key)
 *   PATCH  /elevenlabs/credentials       — partial update; encrypts api key
 *   DELETE /elevenlabs/credentials       — drops the row for this agent
 *   POST   /elevenlabs/credentials/test  — proxies /v1/user, persists outcome
 *
 * Runtime state (encryption key + db handle) lives in
 * `apps/agent/src/credentials/elevenlabs-runtime.ts` and is installed by
 * `startServer()` once during boot. Both this module and the TTS channel
 * read from those getters so neither layer reaches into the other.
 *
 * Spec: openspec/changes/add-elevenlabs-credential/
 *       openspec/changes/harden-elevenlabs-credential-p2-p3-gcf/
 */

import { randomUUID } from "node:crypto";
import type { Db } from "@nexus/db";
import { elevenlabsCredentials } from "@nexus/db";
import { logger, getAgentId } from "@nexus/core/node";
import { fetchWithTimeout } from "@nexus/core/fetch";
import { elevenlabsPatchInput } from "@nexus/core";
import { eq } from "drizzle-orm";

import { decrypt, encrypt } from "../credentials/encryption";
import { getElevenlabsEncryptionKey } from "../credentials/elevenlabs-runtime";
import { invalidateVoiceCache } from "./elevenlabs-voices";
import type { ElevenlabsCredentialsResponse } from "@nexus/core";

// ── Response helpers ───────────────────────────────────────────────────────

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/**
 * Build the masked GET shape from a row. Crucially this is the ONLY function
 * that reads `valueEncrypted`; callers never see it. `hasKey` is the entire
 * existence-bit signal — no preview, no last-N-chars.
 */
function toResponseShape(
  agentId: string,
  row: typeof elevenlabsCredentials.$inferSelect | null,
): ElevenlabsCredentialsResponse {
  if (!row) {
    return {
      hasKey: false,
      voiceId: null,
      voiceName: null,
      lastTestOkAt: null,
      lastTestStatusCode: null,
      agentId,
    };
  }
  return {
    hasKey: row.valueEncrypted !== null && row.valueEncrypted !== "",
    voiceId: row.voiceId,
    voiceName: row.voiceName,
    lastTestOkAt: row.lastTestOkAt ? row.lastTestOkAt.toISOString() : null,
    lastTestStatusCode: row.lastTestStatusCode,
    agentId,
  };
}

// ── Handlers ───────────────────────────────────────────────────────────────

/** GET /elevenlabs/credentials — returns the masked shape. */
export async function handleGetCredentials(
  db: Db,
  _request: Request,
): Promise<Response> {
  const agentId = getAgentId();
  const row = await db.query.elevenlabsCredentials.findFirst({
    where: eq(elevenlabsCredentials.agentId, agentId),
  });
  return jsonResponse(toResponseShape(agentId, row ?? null));
}

/** PATCH /elevenlabs/credentials — partial upsert. */
export async function handlePatchCredentials(
  db: Db,
  request: Request,
): Promise<Response> {
  const key = getElevenlabsEncryptionKey();
  if (!key) {
    return jsonResponse({ error: "encryption key not configured" }, 400);
  }

  let rawBody: unknown;
  try {
    rawBody = await request.json();
  } catch {
    return jsonResponse({ error: "invalid json body" }, 400);
  }

  const parsed = elevenlabsPatchInput.safeParse(rawBody);
  if (!parsed.success) {
    return jsonResponse(
      { error: "invalid input", detail: parsed.error.issues },
      400,
    );
  }

  const { apiKey, voiceId, voiceName } = parsed.data;
  if (apiKey === undefined && voiceId === undefined && voiceName === undefined) {
    return jsonResponse({ error: "no fields supplied" }, 400);
  }

  const agentId = getAgentId();
  const existing = await db.query.elevenlabsCredentials.findFirst({
    where: eq(elevenlabsCredentials.agentId, agentId),
  });

  if (existing) {
    const update: Partial<typeof elevenlabsCredentials.$inferInsert> = {};
    if (apiKey !== undefined) update.valueEncrypted = encrypt(apiKey, key);
    if (voiceId !== undefined) update.voiceId = voiceId;
    if (voiceName !== undefined) update.voiceName = voiceName;

    await db
      .update(elevenlabsCredentials)
      .set(update)
      .where(eq(elevenlabsCredentials.agentId, agentId));
  } else {
    await db.insert(elevenlabsCredentials).values({
      id: randomUUID(),
      agentId,
      valueEncrypted: apiKey !== undefined ? encrypt(apiKey, key) : null,
      voiceId: voiceId ?? null,
      voiceName: voiceName ?? null,
    });
  }

  // The voice list cache keys on agentId and is a function of the apiKey.
  // Rotating the apiKey MUST invalidate so the next /voices fetch goes
  // upstream rather than returning entries authorized by the old key.
  if (apiKey !== undefined) {
    invalidateVoiceCache(agentId);
  }

  const refreshed = await db.query.elevenlabsCredentials.findFirst({
    where: eq(elevenlabsCredentials.agentId, agentId),
  });
  return jsonResponse(toResponseShape(agentId, refreshed ?? null));
}

/** DELETE /elevenlabs/credentials — drop the row. */
export async function handleDeleteCredentials(
  db: Db,
  _request: Request,
): Promise<Response> {
  const agentId = getAgentId();
  await db
    .delete(elevenlabsCredentials)
    .where(eq(elevenlabsCredentials.agentId, agentId));
  // Always evict — even if the row didn't exist, ensuring no stale cache
  // outlives a delete is cheaper than racing the existence check.
  invalidateVoiceCache(agentId);
  return new Response(null, { status: 204 });
}

/**
 * POST /elevenlabs/credentials/test — probe `/v1/user` with the stored key.
 *
 * Persists `last_test_status_code` regardless of outcome and `last_test_ok_at`
 * only on 2xx. Returns the optional `subscription` block when the upstream
 * shape includes it.
 *
 * When the upstream fetch *throws* (DNS failure, timeout, connection refused),
 * persists `last_test_status_code = NULL` (no HTTP exchange occurred) and
 * returns `{ ok: false, statusCode: null, error: "network" }`.
 */
export async function handleTestConnection(
  db: Db,
  _request: Request,
): Promise<Response> {
  const key = getElevenlabsEncryptionKey();
  if (!key) {
    return jsonResponse({ error: "encryption key not configured" }, 400);
  }

  const agentId = getAgentId();
  const row = await db.query.elevenlabsCredentials.findFirst({
    where: eq(elevenlabsCredentials.agentId, agentId),
  });
  if (!row || !row.valueEncrypted) {
    return jsonResponse({ error: "no credential stored" }, 400);
  }

  let apiKey: string;
  try {
    apiKey = decrypt(row.valueEncrypted, key);
  } catch (err) {
    logger.error({ err, agentId }, "elevenlabs: failed to decrypt stored key");
    return jsonResponse({ error: "could not decrypt stored credential" }, 500);
  }

  let statusCode: number | null = null;
  let subscription: ElevenlabsTestSubscriptionShape | undefined;
  let networkError = false;
  try {
    const res = await fetchWithTimeout("https://api.elevenlabs.io/v1/user", {
      method: "GET",
      headers: { "xi-api-key": apiKey },
      timeout: 5_000,
    });
    statusCode = res.status;
    if (res.ok) {
      try {
        const body = (await res.json()) as RawUserResponse;
        const sub = body?.subscription;
        if (sub) {
          subscription = {
            tier: typeof sub.tier === "string" ? sub.tier : "unknown",
            characterCount:
              typeof sub.character_count === "number" ? sub.character_count : 0,
            characterLimit:
              typeof sub.character_limit === "number" ? sub.character_limit : 0,
            nextResetUnix:
              typeof sub.next_character_count_reset_unix === "number"
                ? sub.next_character_count_reset_unix
                : 0,
          };
        }
      } catch {
        // Ignore body parse errors — statusCode + subscription:undefined is
        // still a valid response.
      }
    }
  } catch (err) {
    logger.warn(
      { err, agentId },
      "elevenlabs: test probe failed (network/timeout)",
    );
    networkError = true;
    statusCode = null;
  }

  // Persist outcome — last_test_status_code stores the actual code or NULL
  // for network failures. last_test_ok_at only on 2xx.
  const ok =
    statusCode !== null && statusCode >= 200 && statusCode < 300;
  await db
    .update(elevenlabsCredentials)
    .set({
      lastTestStatusCode: statusCode,
      ...(ok ? { lastTestOkAt: new Date() } : {}),
    })
    .where(eq(elevenlabsCredentials.agentId, agentId));

  const responseBody: {
    ok: boolean;
    statusCode: number | null;
    error?: string;
    subscription?: ElevenlabsTestSubscriptionShape;
  } = { ok, statusCode };
  if (networkError) responseBody.error = "network";
  if (subscription) responseBody.subscription = subscription;
  return jsonResponse(responseBody);
}

// ── Internal upstream-shape types ─────────────────────────────────────────

interface RawUserResponse {
  subscription?: {
    tier?: unknown;
    character_count?: unknown;
    character_limit?: unknown;
    next_character_count_reset_unix?: unknown;
  };
}

interface ElevenlabsTestSubscriptionShape {
  tier: string;
  characterCount: number;
  characterLimit: number;
  nextResetUnix: number;
}
