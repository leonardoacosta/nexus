/**
 * Credential pool lifecycle: initialize, read, and reset the singleton.
 *
 * The underlying storage is `poolRef.current` in `./shared.ts` — every handler
 * module reads from the same ref, so `initCredentialRoutes` installs the pool
 * once and all routes pick it up without per-module wiring.
 */

import type { Db } from "@nexus/db";
import { CredentialPool } from "../../credentials/pool";
import { poolRef, dbRef } from "./shared";

/** Initialize credential routes with a database connection. */
export function initCredentialRoutes(
  db: Db,
  options?: {
    cooldownMs?: number;
    leaseTtlMs?: number;
    encryptionKey?: import("node:buffer").Buffer;
    prerotateThreshold?: number;
  },
): void {
  poolRef.current = new CredentialPool(db, options);
  dbRef.current = db;
}

/** Get the pool (for testing). */
export function getCredentialPool(): CredentialPool | null {
  return poolRef.current;
}

/** Reset state (for testing). */
export function resetCredentialRoutes(): void {
  if (poolRef.current) poolRef.current.stopCleanup();
  poolRef.current = null;
  dbRef.current = null;
}
