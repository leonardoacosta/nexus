/**
 * ElevenLabs voice list proxy with bounded LRU + 1-hour TTL cache per agent.
 *
 * The dashboard's voice dropdown calls this endpoint instead of hitting
 * ElevenLabs directly so:
 *   1. The user's API key never leaves the agent.
 *   2. We can cache the list (it changes ~weekly) and avoid burning quota
 *      on dashboard renders.
 *   3. We can serve stale-on-error: if upstream throws or 5xxs, we return
 *      the last cached list so the dashboard stays usable.
 *
 * Cache shape:
 *   - 1-hour TTL per entry (`CACHE_TTL_MS`)
 *   - 32-entry LRU cap (`MAX_CACHE_ENTRIES`) — deleting + re-inserting on
 *     hit refreshes insertion order; insertion past cap evicts the oldest
 *     (Map iteration order is insertion order per ECMAScript spec).
 *   - `invalidateVoiceCache(agentId)` evicts a single entry — called by
 *     `handlePatchCredentials` (when apiKey changes) and
 *     `handleDeleteCredentials` (unconditionally) so cached voices never
 *     reflect a stale or revoked key.
 *
 * Spec: openspec/changes/add-elevenlabs-credential/
 */

import type { Db } from "@nexus/db";
import { elevenlabsCredentials } from "@nexus/db";
import { logger, getAgentId } from "@nexus/core/node";
import { fetchWithTimeout } from "@nexus/core/fetch";
import { eq } from "drizzle-orm";

import { decrypt, tryLoadEncryptionKey } from "../credentials/encryption";
import type { ElevenlabsVoicesResponse } from "@nexus/core";

interface CacheEntry {
  fetchedAt: number;
  voices: ElevenlabsVoicesResponse["voices"];
}

const CACHE_TTL_MS = 60 * 60 * 1_000; // 1 hour
const MAX_CACHE_ENTRIES = 32;
const cache = new Map<string, CacheEntry>();

/** Touch an LRU entry — delete + reinsert refreshes insertion order. */
function touch(agentId: string, entry: CacheEntry): void {
  cache.delete(agentId);
  cache.set(agentId, entry);
}

/** Insert with bounded eviction — oldest entry drops when at cap. */
function setBounded(agentId: string, entry: CacheEntry): void {
  cache.delete(agentId); // ensure re-insertion refreshes order
  if (cache.size >= MAX_CACHE_ENTRIES) {
    const oldestKey = cache.keys().next().value;
    if (oldestKey !== undefined) cache.delete(oldestKey);
  }
  cache.set(agentId, entry);
}

/** Reset cache (testing only). */
export function resetVoiceCache(): void {
  cache.clear();
}

/**
 * Drop the cached voice list for one agent. Called by credential mutation
 * handlers so a freshly-rotated apiKey never returns stale voices.
 */
export function invalidateVoiceCache(agentId: string): void {
  cache.delete(agentId);
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

interface RawVoicesResponse {
  voices?: Array<{
    voice_id?: unknown;
    name?: unknown;
    labels?: unknown;
  }>;
}

/** GET /elevenlabs/voices — cached proxy of ElevenLabs `/v1/voices`. */
export async function handleListVoices(
  db: Db,
  _request: Request,
): Promise<Response> {
  const agentId = getAgentId();
  const now = Date.now();

  const cached = cache.get(agentId);
  if (cached && now - cached.fetchedAt < CACHE_TTL_MS) {
    touch(agentId, cached);
    return jsonResponse({ voices: cached.voices });
  }

  // Cache miss — need decrypted key to fetch upstream.
  const key = tryLoadEncryptionKey();
  if (!key) {
    return jsonResponse({ error: "encryption key not configured" }, 400);
  }

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
    logger.error({ err, agentId }, "elevenlabs voices: decrypt failed");
    return jsonResponse({ error: "decryption failed" }, 500);
  }

  try {
    const res = await fetchWithTimeout("https://api.elevenlabs.io/v1/voices", {
      method: "GET",
      headers: { "xi-api-key": apiKey },
      timeout: 5_000,
    });

    if (res.status === 401 || res.status === 403) {
      return jsonResponse({ error: "invalid key" }, 401);
    }

    if (res.status >= 500) {
      // Upstream 5xx: serve cached list if any, else 503.
      if (cached) {
        return jsonResponse({ voices: cached.voices });
      }
      return jsonResponse({ error: "upstream unavailable" }, 503);
    }

    if (!res.ok) {
      return jsonResponse({ error: `upstream HTTP ${res.status}` }, 502);
    }

    const body = (await res.json()) as RawVoicesResponse;
    type Voice = ElevenlabsVoicesResponse["voices"][number];
    const voices: Voice[] = [];
    for (const v of body.voices ?? []) {
      const voiceId = typeof v.voice_id === "string" ? v.voice_id : null;
      const name = typeof v.name === "string" ? v.name : null;
      if (!voiceId || !name) continue;
      const labels =
        v.labels && typeof v.labels === "object" && !Array.isArray(v.labels)
          ? (v.labels as Record<string, string>)
          : undefined;
      const entry: Voice = { voiceId, name };
      if (labels) entry.labels = labels;
      voices.push(entry);
    }

    setBounded(agentId, { fetchedAt: now, voices });
    return jsonResponse({ voices });
  } catch (err) {
    logger.warn({ err, agentId }, "elevenlabs voices: fetch failed");
    if (cached) {
      return jsonResponse({ voices: cached.voices });
    }
    return jsonResponse({ error: "upstream unavailable" }, 503);
  }
}
