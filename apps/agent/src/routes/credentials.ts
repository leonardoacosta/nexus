import type { Db } from "@nexus/db";
import { CredentialPool } from "../credentials/pool";

// Singleton pool — initialized once via initCredentialRoutes()
let pool: CredentialPool | null = null;

/** Initialize credential routes with a database connection. */
export function initCredentialRoutes(
  db: Db,
  options?: { cooldownMs?: number; leaseTtlMs?: number },
): void {
  pool = new CredentialPool(db, options);
}

/** Get the pool (for testing). */
export function getCredentialPool(): CredentialPool | null {
  return pool;
}

/** Reset state (for testing). */
export function resetCredentialRoutes(): void {
  if (pool) pool.stopCleanup();
  pool = null;
}

/** POST /credentials — add a new credential. */
export async function handleAddCredential(request: Request): Promise<Response> {
  if (!pool) {
    return jsonResponse({ error: "credential system not initialized" }, 500);
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return jsonResponse({ error: "invalid JSON body" }, 400);
  }

  const { id, name, type, value } = body as Record<string, unknown>;

  if (!id || typeof id !== "string") {
    return jsonResponse({ error: "id is required and must be a string" }, 400);
  }
  if (!name || typeof name !== "string") {
    return jsonResponse({ error: "name is required and must be a string" }, 400);
  }
  if (!type || typeof type !== "string") {
    return jsonResponse({ error: "type is required and must be a string" }, 400);
  }
  if (!value || typeof value !== "string") {
    return jsonResponse({ error: "value is required and must be a string" }, 400);
  }

  try {
    await pool.add({
      id: id as string,
      name: name as string,
      type: type as string,
      value_encrypted: value as string,
    });
  } catch (err) {
    return jsonResponse(
      { error: err instanceof Error ? err.message : "failed to add credential" },
      409,
    );
  }

  return jsonResponse({ id, name, type, status: "available" }, 201);
}

/** POST /credentials/lease — lease an available credential. */
export async function handleLeaseCredential(request: Request): Promise<Response> {
  if (!pool) {
    return jsonResponse({ error: "credential system not initialized" }, 500);
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return jsonResponse({ error: "invalid JSON body" }, 400);
  }

  const { type, leased_by } = body as Record<string, unknown>;

  if (!type || typeof type !== "string") {
    return jsonResponse({ error: "type is required and must be a string" }, 400);
  }
  if (!leased_by || typeof leased_by !== "string") {
    return jsonResponse({ error: "leased_by is required and must be a string" }, 400);
  }

  const credential = await pool.lease(type as string, leased_by as string);

  if (!credential) {
    return jsonResponse({ error: "no available credentials of this type" }, 409);
  }

  // Don't expose the encrypted value
  const { valueEncrypted: _, ...safe } = credential;
  return jsonResponse(safe);
}

/** POST /credentials/{id}/release — release a leased credential. */
export async function handleReleaseCredential(id: string): Promise<Response> {
  if (!pool) {
    return jsonResponse({ error: "credential system not initialized" }, 500);
  }

  const success = await pool.release(id);

  if (!success) {
    return jsonResponse({ error: "credential not found or not in leased state" }, 404);
  }

  return jsonResponse({ id, status: "available" });
}

/** GET /credentials — list all credentials (no values). */
export async function handleListCredentials(): Promise<Response> {
  if (!pool) {
    return jsonResponse({ error: "credential system not initialized" }, 500);
  }

  return jsonResponse(await pool.list());
}

/** POST /credentials/{id}/report-rate-limit — report rate limit, trigger cooldown + rotation. */
export async function handleReportRateLimit(
  id: string,
  request: Request,
): Promise<Response> {
  if (!pool) {
    return jsonResponse({ error: "credential system not initialized" }, 500);
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return jsonResponse({ error: "invalid JSON body" }, 400);
  }

  const { leased_by } = body as Record<string, unknown>;

  if (!leased_by || typeof leased_by !== "string") {
    return jsonResponse({ error: "leased_by is required and must be a string" }, 400);
  }

  const result = await pool.reportRateLimit(id, leased_by as string);

  if (!result) {
    return jsonResponse({ error: "credential not found" }, 404);
  }

  const { valueEncrypted: _1, ...cooledDown } = result.cooledDown;
  const next = result.next
    ? (() => {
        const { valueEncrypted: _2, ...safe } = result.next!;
        return safe;
      })()
    : null;

  return jsonResponse({ cooled_down: cooledDown, next });
}

function jsonResponse(data: unknown, status: number = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
