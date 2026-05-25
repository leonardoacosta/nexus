import { describe, test, expect, beforeEach, afterEach, mock } from "bun:test";
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
});
