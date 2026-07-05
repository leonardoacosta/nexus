import { describe, test, expect, mock, afterAll } from "bun:test";
import * as nexusCore from "@nexus/core";
import * as realSessions from "../db/sessions";
import * as realEvents from "../db/events";
import { installExecMock } from "../testing/mock-exec";

// Mock @nexus/core logger before any route imports.
const loggerMock = {
  warn: mock(() => {}),
  info: mock(() => {}),
  error: mock(() => {}),
  debug: mock(() => {}),
  child: mock(() => loggerMock),
};

// Spread the real module so non-logger exports (narrowSessionStatus, etc.)
// survive this process-global mock.module override.
mock.module("@nexus/core", () => ({
  ...nexusCore,
  logger: loggerMock,
  createLogger: () => loggerMock,
}));

// SPREAD the real db modules. These suites only assert that the split route
// files EXPORT their handlers (typeof === "function") — they never invoke a db
// helper — so the real (lazy, no-connection-at-import) functions are safe here.
// A non-spreading `mock.module` here was process-global + irreversible and
// leaked into sibling suites: its `getSessionById: () => null` override made
// session-cost-read.test.ts's handleGetSessionTokens return 404, and stripping
// exports like `recordSessionStop` crashed other suites (nx-jlx1c).
mock.module("../db/sessions", () => ({ ...realSessions }));
mock.module("../db/events", () => ({ ...realEvents }));

// Mock config-loader since it may not be initialized in test context.
mock.module("../services/config-loader", () => ({
  getProjects: () => [],
  getSettings: () => ({}),
  initConfigLoader: () => {},
  stopConfigLoader: () => {},
}));

// Stub exec utils to prevent real subprocess spawning. Uses a RESTORABLE
// spyOn (nx-509z5 class) so the real `../utils/exec` is handed back to sibling
// suites (utils/exec.test.ts) that load later — see testing/mock-exec.ts.
const execMockHandle = installExecMock({
  execText: () => Promise.resolve(""),
  execJson: () => Promise.resolve([]),
});
afterAll(() => execMockHandle.restore());

describe("split route files — handler exports", () => {
  test("statusline.ts exports handleStatusline", async () => {
    const mod = await import("./statusline");
    expect(typeof mod.handleStatusline).toBe("function");
  });

  test("recommend.ts exports handleRecommend", async () => {
    const mod = await import("./recommend");
    expect(typeof mod.handleRecommend).toBe("function");
  });

  test("environment-route.ts exports handleEnvironment", async () => {
    const mod = await import("./environment-route");
    expect(typeof mod.handleEnvironment).toBe("function");
  });

  test("failures-route.ts exports handleFailures", async () => {
    const mod = await import("./failures-route");
    expect(typeof mod.handleFailures).toBe("function");
  });

  test("cron-routes.ts exports handleCron", async () => {
    const mod = await import("./cron-routes");
    expect(typeof mod.handleCron).toBe("function");
  });
});

describe("split route files — response shape", () => {
  test("handleFailures returns valid JSON with expected fields", async () => {
    const { handleFailures } = await import("./failures-route");
    const url = new URL("http://localhost:7400/failures");
    const response = await handleFailures(url);

    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      period_days: number;
      total: number;
      by_tool: unknown;
      trend: unknown;
    };
    expect(body).toHaveProperty("period_days");
    expect(body).toHaveProperty("total");
    expect(body).toHaveProperty("by_tool");
    expect(body).toHaveProperty("trend");
  });

  test("handleFailures respects days param", async () => {
    const { handleFailures } = await import("./failures-route");
    const url = new URL("http://localhost:7400/failures?days=30");
    const response = await handleFailures(url);

    const body = (await response.json()) as { period_days: number };
    expect(body.period_days).toBe(30);
  });

  test("handleCron returns valid JSON with jobs", async () => {
    const { handleCron } = await import("./cron-routes");
    // No db provided — route returns nullish reaper fields without touching PG.
    const response = await handleCron();

    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      jobs: {
        maintain: { schedule: string };
        drift: { schedule: string };
        reaper: { schedule: string; last_run: string | null };
      };
    };
    expect(body).toHaveProperty("jobs");
    expect(body.jobs).toHaveProperty("maintain");
    expect(body.jobs).toHaveProperty("drift");
    expect(body.jobs).toHaveProperty("reaper");
    expect(body.jobs.maintain.schedule).toBe("daily @ 00:17");
    expect(body.jobs.drift.schedule).toBe("weekly @ Sun 09:00");
    expect(body.jobs.reaper.schedule).toBe("weekly @ Sun 03:00");
    expect(body.jobs.reaper.last_run).toBeNull();
  });

});
