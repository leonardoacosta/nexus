import type { Db } from "@nexus/db";
import { credentials } from "@nexus/db";
import type { CredentialStatus } from "@nexus/core";
import { eq, and, lte, lt, asc } from "drizzle-orm";

/** Row shape returned from the `credentials` table. */
export type CredentialRow = typeof credentials.$inferSelect;

/** Insert a new credential into the pool. */
export async function insertCredential(db: Db, row: CredentialRow): Promise<void> {
  await db.insert(credentials).values(row);
}

/** Get a credential by id. */
export async function getCredentialById(
  db: Db,
  id: string,
): Promise<CredentialRow | null> {
  const rows = await db
    .select()
    .from(credentials)
    .where(eq(credentials.id, id))
    .limit(1);
  return rows[0] ?? null;
}

/** Query all credentials, ordered by name. */
export async function queryAllCredentials(db: Db): Promise<CredentialRow[]> {
  return db.select().from(credentials).orderBy(asc(credentials.name));
}

/** Query credentials by status. */
export async function queryCredentialsByStatus(
  db: Db,
  status: CredentialStatus,
): Promise<CredentialRow[]> {
  return db
    .select()
    .from(credentials)
    .where(eq(credentials.status, status))
    .orderBy(asc(credentials.name));
}

/** Update a credential's status and lease info. */
export async function updateCredentialStatus(
  db: Db,
  id: string,
  status: CredentialStatus,
  leasedBy: string | null = null,
  leasedAt: Date | null = null,
  cooldownUntil: Date | null = null,
): Promise<void> {
  await db
    .update(credentials)
    .set({ status, leasedBy, leasedAt, cooldownUntil })
    .where(eq(credentials.id, id));
}

/** Query credentials whose cooldown has expired. */
export async function queryExpiredCooldowns(db: Db): Promise<CredentialRow[]> {
  const now = new Date();
  return db
    .select()
    .from(credentials)
    .where(and(eq(credentials.status, "cooldown"), lte(credentials.cooldownUntil, now)));
}

/** Query credentials with stale leases (leased_at older than the given threshold). */
export async function queryStaleLeases(
  db: Db,
  olderThan: Date,
): Promise<CredentialRow[]> {
  return db
    .select()
    .from(credentials)
    .where(and(eq(credentials.status, "leased"), lt(credentials.leasedAt, olderThan)));
}
