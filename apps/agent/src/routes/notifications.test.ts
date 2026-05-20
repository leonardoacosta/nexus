/**
 * Contract test for GET /notifications emission shape.
 *
 * Added by `agent-payload-completeness` (task 1.9). Pins the
 * `severity` + `delivery_state` Swift-facing enums on each row, the
 * ISO-8601 string projection on `created_at`, and the empty-list
 * contract (200 with `[]`, never 404).
 *
 * Uses a fake DB rather than live PG to keep the test contract-focused
 * and CI-portable. The real DB pathway is exercised by the homelab
 * curl check during /apply verification.
 */

import { describe, it, expect } from "bun:test";
import type { Db } from "@nexus/db";
import { handleListNotifications } from "./notifications";

function makeFakeDb(rows: unknown[]): Db {
  // Minimal stub satisfying the chained query API the handler uses:
  //   db.select({...}).from(table).orderBy(...).limit(n)
  const builder = {
    from() {
      return this;
    },
    orderBy() {
      return this;
    },
    limit(): Promise<unknown[]> {
      return Promise.resolve(rows);
    },
  };
  return {
    select(): typeof builder {
      return builder;
    },
  } as unknown as Db;
}

describe("handleListNotifications — wire shape (agent-payload-completeness)", () => {
  it("returns 200 with [] on empty (never 404)", async () => {
    const db = makeFakeDb([]);
    const res = await handleListNotifications(db);
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("application/json");
    const body = await res.json();
    expect(body).toEqual([]);
  });

  it("emits severity, delivery_state, and ISO-8601 created_at on every row", async () => {
    const createdAt = new Date("2026-05-19T10:00:00Z");
    const db = makeFakeDb([
      {
        id: "n-1",
        title: "Build broke",
        body: "ci/tc#1234 failed",
        channel: "desktop",
        project: "tc",
        severity: "warn",
        delivery_state: "delivered",
        created_at: createdAt,
      },
    ]);

    const res = await handleListNotifications(db);
    expect(res.status).toBe(200);

    const body = (await res.json()) as Array<Record<string, unknown>>;
    expect(body).toHaveLength(1);
    const row = body[0]!;
    expect(row.id).toBe("n-1");
    expect(row.severity).toBe("warn");
    expect(row.delivery_state).toBe("delivered");
    expect(row.channel).toBe("desktop");
    // ISO-8601 projection — never a JS Date object on the wire.
    expect(typeof row.created_at).toBe("string");
    expect(row.created_at).toBe(createdAt.toISOString());
  });

  it("returns 500 with error envelope on DB failure", async () => {
    const db = {
      select() {
        throw new Error("db unreachable");
      },
    } as unknown as Db;
    const res = await handleListNotifications(db);
    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: string };
    expect(body).toHaveProperty("error");
  });
});
