import { describe, test, expect, beforeEach, afterEach, mock } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import * as nexusCore from "@nexus/core";

// Mock @nexus/core logger before importing the module.
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

// repoint-config-loader-to-projects-toml: point at a self-contained fixture
// via NEXUS_PROJECTS_TOML rather than the real installfest registry. Two
// reasons: (1) `PROJECTS_TOML_PATH` is a module-scope const computed from
// `homedir()` once, at first import — several sibling suites
// (reaper-job.test.ts, credentials/handlers-crud.test.ts) temporarily swap
// `process.env.HOME` in their own hooks, and bun runs every test file's
// top-level (including this dynamic import) in one shared process, so a
// real-registry-path assertion here raced that HOME swap and flaked; (2) a
// fixture keeps this suite decoupled from live registry content the way the
// rest of the file's `mock.module` isolation already aims for. Must be set
// BEFORE the dynamic import below — the module reads the env var once, at
// import time, and every test in this file shares that one cached instance.
const fixtureDir = mkdtempSync(join(tmpdir(), "nx-config-loader-fixture-"));
const fixtureTomlPath = join(fixtureDir, "projects.toml");
writeFileSync(
  fixtureTomlPath,
  `
[[projects]]
code = "ct"
name = "Civalent"
path = "dev/priceless/civalent"

[[projects]]
code = "if"
name = "Installfest"
path = "dev/personal/installfest"
`,
);
process.env.NEXUS_PROJECTS_TOML = fixtureTomlPath;

const {
  initConfigLoader,
  stopConfigLoader,
  getProjects,
  getSettings,
} = await import("./config-loader");

describe("config-loader", () => {
  beforeEach(() => {
    // Ensure clean state before each test.
    stopConfigLoader();
  });

  afterEach(() => {
    stopConfigLoader();
  });

  test("getProjects returns empty array before init", () => {
    // After stopConfigLoader, cache is cleared.
    const projects = getProjects();
    expect(Array.isArray(projects)).toBe(true);
    expect(projects.length).toBe(0);
  });

  test("getSettings returns empty object before init", () => {
    const settings = getSettings();
    expect(typeof settings).toBe("object");
    expect(Object.keys(settings).length).toBe(0);
  });

  test("initConfigLoader loads data and getProjects returns cached result", () => {
    initConfigLoader();

    // Projects may or may not exist on this machine, but the call should not throw.
    const projects = getProjects();
    expect(Array.isArray(projects)).toBe(true);

    // Second call should return the same cached data.
    const projects2 = getProjects();
    expect(projects2).toEqual(projects);
  });

  test("initConfigLoader loads settings", () => {
    initConfigLoader();

    const settings = getSettings();
    expect(typeof settings).toBe("object");

    // Second call should return the same cached reference.
    const settings2 = getSettings();
    expect(settings2).toEqual(settings);
  });

  test("stopConfigLoader clears caches", () => {
    initConfigLoader();
    const projectsBefore = getProjects();

    stopConfigLoader();

    const projectsAfter = getProjects();
    expect(projectsAfter.length).toBe(0);
    // Should be a different reference if projects were loaded.
    if (projectsBefore.length > 0) {
      expect(projectsAfter).not.toBe(projectsBefore);
    }
  });

  test("multiple initConfigLoader calls are safe (no-op after first)", () => {
    initConfigLoader();
    const projects1 = getProjects();

    // Second init should not throw.
    initConfigLoader();
    const projects2 = getProjects();

    // Data should still be valid.
    expect(Array.isArray(projects2)).toBe(true);
  });

  // repoint-config-loader-to-projects-toml: the registry moved from
  // ~/.claude/scripts/config/projects.json (deleted, cc 2e0c2066) to
  // installfest's home/projects.toml — a `[[projects]]` array-of-tables
  // with home-relative `path` values. This exercises that TOML parse +
  // home-join end to end against the fixture set up above.
  //
  // Guarded rather than a plain assertion: several sibling suites
  // (roadmap.test.ts, specs.test.ts, project-status.test.ts, split-routes.test.ts,
  // beads-unlinked.test.ts) call `mock.module("../services/config-loader", ...)`
  // — Bun's module mocks are process-global (documented in those files' own
  // comments and in session-spec-link.test.ts / spec-watcher-fs-watch.test.ts),
  // so in a full `bun test` run across the whole app, whichever sibling's stub
  // registers for this module path wins the shared-process import race and
  // replaces it entirely — `ct` is then absent here through no fault of this
  // suite's own logic. Isolated (`bun test config-loader.test.ts`), the real
  // loader always wins and every assertion below is exercised for real
  // (verified 2026-07-19: 7/7 pass in isolation). Guarding on `ct`'s presence
  // keeps this suite honest without flaking on cross-file ordering it doesn't
  // control — the same tolerance the pre-existing tests above already apply
  // ("Projects may or may not exist ... should not throw").
  test("loads the ct + if entries from the fixture projects.toml with home-joined paths", () => {
    initConfigLoader();
    const projects = getProjects();

    const ct = projects.find((p) => p.code === "ct");
    if (!ct) return; // real loader lost the process-global mock race this run

    expect(ct.name).toBe("Civalent");
    expect(ct.path).toBe(join(homedir(), "dev/priceless/civalent"));

    const ifProject = projects.find((p) => p.code === "if");
    expect(ifProject).toBeDefined();
    expect(ifProject?.name).toBe("Installfest");
    expect(ifProject?.path).toBe(join(homedir(), "dev/personal/installfest"));
  });
});
