/**
 * HTTP-boundary acceptance for the `telegram` notification channel
 * (add-mx-credential-autorefresh).
 *
 * Spec scenario "A telegram-channel notification is delivered":
 *   - POST /notifications/send {channel:"telegram"} is ACCEPTED (not 400 at
 *     the VALID_CHANNELS allowlist) and dispatched through the router.
 *   - When no Telegram bot creds are provisioned the channel fails open — the
 *     request is still accepted and the delivery no-ops (no error surfaced).
 *
 * The telegram delivery itself (Bot API POST + fail-open paths) is unit-tested
 * in `notifications/router.test.ts`. This file pins the route-layer contract:
 * telegram is a first-class accepted channel, not eaten by the 400 path.
 *
 * Mirrors `notifications-deliver.test.ts`: the shared core-node mock silences
 * the logger and the lifecycle bus emit is spied so no real SSE fan-out runs.
 */

import {
  describe,
  it,
  expect,
  spyOn,
  beforeAll,
  afterAll,
  beforeEach,
} from "bun:test";
import type { Db } from "@nexus/db";
import { lifecycleBus } from "../services/lifecycle-bus";
import { installCoreNodeMock } from "../testing/mock-core-node";

installCoreNodeMock();

const { handleSendNotification, initNotificationRoutes, resetNotificationRoutes } =
  await import("./notifications");

// ── Fake Db ──────────────────────────────────────────────────────────────
//
// Satisfies the chained calls the manager + presence/held-queue init perform:
//   - db.insert(table).values(row)            (insertNotification)
//   - db.update(table).set(...).where(...)    (markNotificationDelivered)
//   - db.query.notificationSettings.findFirst (presence flag read → false)
//   - db.select()...orderBy().limit()         (held-queue hydrate → [])
// All persistence is a no-op; we only care that send() routes to the channel.
function makeFakeDb(): Db {
  const insertChain = { values: async () => undefined };
  const updateChain = {
    set() {
      return this;
    },
    where: async () => undefined,
  };
  // Chainable + thenable: `select().from().where().orderBy()` (held-queue
  // terminal) and `select().from().orderBy().limit()` (list terminal) both
  // resolve to `[]`. The `then` makes awaiting the builder at ANY terminal
  // yield an (empty, iterable) array.
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

function makeReq(body: unknown): Request {
  return new Request("http://127.0.0.1:7400/notifications/send", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

let emitSpy: ReturnType<typeof spyOn>;
const prevToken = process.env.TELEGRAM_BOT_TOKEN;
const prevChatId = process.env.TELEGRAM_CHAT_ID;

describe("POST /notifications/send — telegram channel acceptance", () => {
  beforeAll(async () => {
    emitSpy = spyOn(lifecycleBus, "emit").mockImplementation(
      () => undefined as never,
    );
    await initNotificationRoutes(makeFakeDb());
  });

  afterAll(async () => {
    emitSpy.mockRestore();
    await resetNotificationRoutes();
    if (prevToken === undefined) delete process.env.TELEGRAM_BOT_TOKEN;
    else process.env.TELEGRAM_BOT_TOKEN = prevToken;
    if (prevChatId === undefined) delete process.env.TELEGRAM_CHAT_ID;
    else process.env.TELEGRAM_CHAT_ID = prevChatId;
  });

  beforeEach(() => {
    // Unprovisioned: the telegram handler no-ops (no real Bot API call), but
    // the route MUST still accept + dispatch (fail-open at the channel layer).
    delete process.env.TELEGRAM_BOT_TOKEN;
    delete process.env.TELEGRAM_CHAT_ID;
  });

  it("accepts channel=telegram (201, not 400) and dispatches", async () => {
    const db = makeFakeDb();
    const res = await handleSendNotification(
      db,
      makeReq({
        id: `tg-route-${Date.now()}`,
        channel: "telegram",
        title: "mx cred",
        body: "fb-bearer-dev refresh failed: az session expired",
      }),
    );

    // 201 = queued + dispatched. A rejected channel would have been 400 with
    // a "channel must be one of: ..." envelope.
    expect(res.status).toBe(201);
    const row = (await res.json()) as { channel: string };
    expect(row.channel).toBe("telegram");
  });

  it("still rejects a genuinely unknown channel with 400", async () => {
    const db = makeFakeDb();
    const res = await handleSendNotification(
      db,
      makeReq({
        id: `tg-bad-${Date.now()}`,
        channel: "carrier-pigeon",
        title: "mx cred",
        body: "should be rejected",
      }),
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("channel must be one of");
    // Telegram is advertised in the allowlist error message.
    expect(body.error).toContain("telegram");
  });
});
