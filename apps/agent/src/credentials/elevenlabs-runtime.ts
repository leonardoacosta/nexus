/**
 * ElevenLabs runtime state — the single source of truth for the
 * encryption key buffer + DB handle that both `routes/elevenlabs-credentials.ts`
 * and `notifications/channels/tts.ts` consume.
 *
 * Replaces the previous bifurcated module-level singletons:
 *   - `elevenlabsKeyRef` (was in routes/elevenlabs-credentials.ts)
 *   - `ambientDb` / `setTtsDb` / `resetTtsDb` (was in notifications/channels/tts.ts)
 *
 * The TTS channel used to import `getElevenlabsEncryptionKey` *upward* from
 * the routes layer — exactly the inversion this module fixes. Both consumers
 * now import from this layer-neutral module instead.
 *
 * Set once at server startup (`startServer()` in server.ts). Never mutated
 * thereafter at runtime — tests reset via `resetElevenlabsRuntime()`.
 *
 * Spec: openspec/changes/harden-elevenlabs-credential-p2-p3-gcf/
 */

import type { Db } from "@nexus/db";

let dbRef: Db | undefined;
let keyRef: Buffer | undefined;

/**
 * Install (or replace) the ElevenLabs runtime state.
 *
 * Both fields are optional — passing only `encryptionKey` leaves any
 * previously-installed `db` in place, and vice versa. Pass `undefined`
 * explicitly to clear an individual field.
 */
export function setElevenlabsRuntime(input: {
  db?: Db;
  encryptionKey?: Buffer;
}): void {
  if ("db" in input) dbRef = input.db;
  if ("encryptionKey" in input) keyRef = input.encryptionKey;
}

/** Read the installed Drizzle DB handle. Returns undefined when unset. */
export function getElevenlabsDb(): Db | undefined {
  return dbRef;
}

/** Read the installed master encryption key. Returns undefined when unset. */
export function getElevenlabsEncryptionKey(): Buffer | undefined {
  return keyRef;
}

/** Reset both refs (testing only). */
export function resetElevenlabsRuntime(): void {
  dbRef = undefined;
  keyRef = undefined;
}
