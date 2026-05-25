import { describe, test, expect, mock } from "bun:test";
import * as nexusCore from "@nexus/core";

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

// Mock DB modules to avoid needing a real database.
mock.module("../db/sessions", () => ({
  queryActiveSessions: mock(() => Promise.resolve([])),
  queryRecentSessions: mock(() => Promise.resolve([])),
  getSessionById: mock(() => Promise.resolve(null)),
  upsertSession: mock(() => Promise.resolve()),
  updateSessionStatus: mock(() => Promise.resolve()),
  insertSession: mock(() => Promise.resolve()),
  loadActiveSessions: mock(() => Promise.resolve([])),
}));

mock.module("../db/events", () => ({
  appendSessionEvent: mock(() => Promise.resolve(1)),
  querySessionEvents: mock(() => Promise.resolve([])),
}));

// Mock config-loader since it may not be initialized in test context.
mock.module("../services/config-loader", () => ({
  getProjects: () => [],
  getSettings: () => ({}),
  initConfigLoader: () => {},
  stopConfigLoader: () => {},
}));

// Mock exec utils to prevent real subprocess spawning.
mock.module("../utils/exec", () => ({
  execText: mock(() => Promise.resolve("")),
  execJson: mock(() => Promise.resolve([])),
  ExecError: class extends Error { exitCode = 1; stderr = ""; },
  ExecTimeoutError: class extends Error { timeoutMs = 10000; },
}));

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
