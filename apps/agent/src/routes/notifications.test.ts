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

import {
  describe,
  it,
  expect,
  beforeAll,
  afterAll,
  afterEach,
} from "bun:test";
import type { Db } from "@nexus/db";
import { lifecycleBus } from "../services/lifecycle-bus";
import type {
  NotificationFiredPayload,
  LifecycleEnvelope,
} from "../services/lifecycle-bus";
import {
  handleListNotifications,
  handleSendNotification,
  initNotificationRoutes,
  resetNotificationRoutes,
} from "./notifications";

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

// ─── POST /notifications/send — session_name/session_id threading ─────────────
//
// drop-permission-request-tts-draft (nx-bidsj.2): the rich `nx_notify` POST
// from cc telemetry.sh now carries session_name/session_id so the banner
// titles `<project> · <session>` (composeTitle, task 1.5b) and deep-links to
// the session. This pins the route-layer contract: present fields thread to
// `manager.send()` extras (observable on the `NotificationFired` envelope);
// absent fields degrade to today's exact shape (no extras).

/**
 * Fake `Db` satisfying the full chain `initNotificationRoutes` +
 * `manager.send()` exercise: insert (persist row), update (audio-column
 * stamp, unused here), select/query (presence + held-queue + settings
 * reads, all no-op/empty), mirroring `notifications-telegram.test.ts`'s
 * fixture — the closest existing exemplar of a full send() round-trip.
 */
function makeSendFakeDb(): Db {
  const insertChain = { values: async () => undefined };
  const updateChain = {
    set() {
      return this;
    },
    where: async () => undefined,
  };
  const selectChain: Record<string, unknown> = {
    from() {
      return selectChain;
    },
    where() {
      return selectChain;
    },
    orderBy() {
      return selectChain;
    },
    limit() {
      return selectChain;
    },
    then(resolve: (rows: unknown[]) => unknown) {
      return Promise.resolve([] as unknown[]).then(resolve);
    },
  };
  return {
    insert: () => insertChain,
    update: () => updateChain,
    select: () => selectChain as unknown,
    query: {
      notificationSettings: {
        findFirst: async () => ({ id: 1, presenceAwareRouting: false }),
      },
      presenceHolds: {
        findMany: async () => [] as unknown[],
      },
    },
  } as unknown as Db;
}

function makeSendReq(body: unknown): Request {
  return new Request("http://127.0.0.1:7400/notifications/send", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

function captureFired(): { events: NotificationFiredPayload[]; off: () => void } {
  const events: NotificationFiredPayload[] = [];
  const handler = (env: LifecycleEnvelope<"NotificationFired">) =>
    events.push(env.payload);
  lifecycleBus.on("NotificationFired", handler);
  return { events, off: () => lifecycleBus.off("NotificationFired", handler) };
}

describe("POST /notifications/send — session_name/session_id threading (nx-bidsj.2)", () => {
  let cap: ReturnType<typeof captureFired>;

  beforeAll(async () => {
    await initNotificationRoutes(makeSendFakeDb());
  });

  afterAll(async () => {
    await resetNotificationRoutes();
  });

  afterEach(() => cap?.off());

  it("threads session_name/session_id to manager.send() extras", async () => {
    cap = captureFired();
    const db = makeSendFakeDb();

    const res = await handleSendNotification(
      db,
      makeSendReq({
        id: `sess-thread-${Date.now()}`,
        channel: "desktop",
        title: "permission requested",
        body: "nx: two questions asked",
        project: "nx",
        session_name: "backend wave",
        session_id: "sess-abc123",
      }),
    );

    expect(res.status).toBe(201);
    expect(cap.events).toHaveLength(1);
    expect(cap.events[0]!.sessionName).toBe("backend wave");
    expect(cap.events[0]!.sessionId).toBe("sess-abc123");
  });

  it("degrades to today's exact shape when session fields are absent", async () => {
    cap = captureFired();
    const db = makeSendFakeDb();

    const res = await handleSendNotification(
      db,
      makeSendReq({
        id: `sess-absent-${Date.now()}`,
        channel: "desktop",
        title: "build broke",
        body: "nx: ci failed",
        project: "nx",
      }),
    );

    expect(res.status).toBe(201);
    expect(cap.events).toHaveLength(1);
    expect(cap.events[0]!.sessionName).toBeUndefined();
    expect(cap.events[0]!.sessionId).toBeUndefined();
  });

  it("treats empty-string session fields as absent (graceful degrade)", async () => {
    cap = captureFired();
    const db = makeSendFakeDb();

    const res = await handleSendNotification(
      db,
      makeSendReq({
        id: `sess-empty-${Date.now()}`,
        channel: "desktop",
        title: "build broke",
        // Distinct body from the sibling test above — the route's dedup
        // filter (isDuplicate, keyed on body+project+channel within a 2min
        // TTL) would otherwise suppress this as a duplicate and return 200
        // instead of 201, unrelated to the session-field behavior under test.
        body: "nx: ci failed (empty-string variant)",
        project: "nx",
        session_name: "",
        session_id: "",
      }),
    );

    expect(res.status).toBe(201);
    expect(cap.events).toHaveLength(1);
    expect(cap.events[0]!.sessionName).toBeUndefined();
    expect(cap.events[0]!.sessionId).toBeUndefined();
  });
});
