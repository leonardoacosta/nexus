import type { Database } from "bun:sqlite";
import type { CredentialStatus } from "@nexus/core";

/** Row shape stored in the `credentials` table. */
export interface CredentialRow {
  id: string;
  name: string;
  type: string;
  value_encrypted: string;
  status: string;
  leased_by: string | null;
  leased_at: string | null;
  cooldown_until: string | null;
}

/** Insert a new credential into the pool. */
export function insertCredential(db: Database, row: CredentialRow): void {
  db.query(
    `INSERT INTO credentials (id, name, type, value_encrypted, status, leased_by, leased_at, cooldown_until)
     VALUES ($id, $name, $type, $value_encrypted, $status, $leased_by, $leased_at, $cooldown_until)`,
  ).run({
    $id: row.id,
    $name: row.name,
    $type: row.type,
    $value_encrypted: row.value_encrypted,
    $status: row.status,
    $leased_by: row.leased_by,
    $leased_at: row.leased_at,
    $cooldown_until: row.cooldown_until,
  });
}

/** Get a credential by id. */
export function getCredentialById(db: Database, id: string): CredentialRow | null {
  return (
    (db.query(`SELECT * FROM credentials WHERE id = $id`).get({ $id: id }) as
      | CredentialRow
      | undefined) ?? null
  );
}

/** Query all credentials, ordered by name. */
export function queryAllCredentials(db: Database): CredentialRow[] {
  return db.query(`SELECT * FROM credentials ORDER BY name ASC`).all() as CredentialRow[];
}

/** Query credentials by status. */
export function queryCredentialsByStatus(
  db: Database,
  status: CredentialStatus,
): CredentialRow[] {
  return db
    .query(`SELECT * FROM credentials WHERE status = $status ORDER BY name ASC`)
    .all({ $status: status }) as CredentialRow[];
}

/** Update a credential's status and lease info. */
export function updateCredentialStatus(
  db: Database,
  id: string,
  status: CredentialStatus,
  leasedBy: string | null = null,
  leasedAt: string | null = null,
  cooldownUntil: string | null = null,
): void {
  db.query(
    `UPDATE credentials
     SET status = $status, leased_by = $leased_by, leased_at = $leased_at, cooldown_until = $cooldown_until
     WHERE id = $id`,
  ).run({
    $id: id,
    $status: status,
    $leased_by: leasedBy,
    $leased_at: leasedAt,
    $cooldown_until: cooldownUntil,
  });
}

/** Query credentials whose cooldown has expired. */
export function queryExpiredCooldowns(db: Database): CredentialRow[] {
  const now = new Date().toISOString();
  return db
    .query(
      `SELECT * FROM credentials WHERE status = 'cooldown' AND cooldown_until <= $now`,
    )
    .all({ $now: now }) as CredentialRow[];
}

/** Query credentials with stale leases (leased_at older than the given threshold). */
export function queryStaleLeases(db: Database, olderThan: string): CredentialRow[] {
  return db
    .query(
      `SELECT * FROM credentials WHERE status = 'leased' AND leased_at < $older_than`,
    )
    .all({ $older_than: olderThan }) as CredentialRow[];
}
