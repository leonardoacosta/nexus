/**
 * Route unit test for registryId propagation (close-registry-id-propagation-gap,
 * task 4.1). A registered project's GET /projects/discovered response carries
 * its canonical `projects.id`; an unregistered project's registryId is null.
 */

import {
  makeDb,
  dirent,
  makeAgentRow,
  resetMocks,
  mockReaddirSync,
  mockExistsSync,
  mockQueryRecentSessions,
  mockGetRegistryIdsByNames,
} from "./projects-discovered.helpers";

import { describe, expect, it, beforeEach } from "bun:test";
import {
  handleGetDiscoveredProjects,
  clearDiscoveredProjectsCache,
} from "./projects-discovered";

describe("GET /projects/discovered — registryId propagation", () => {
  beforeEach(() => {
    clearDiscoveredProjectsCache();
    resetMocks();
  });

  it("carries registryId for a registered project and null for an unregistered one", async () => {
    const db = makeDb([makeAgentRow({ projectsDir: "/home/user/test-projects" })]);

    mockReaddirSync.mockImplementation(() =>
      [
        dirent("registered-app", true),
        dirent("unregistered-app", true),
      ] as unknown as ReturnType<typeof import("node:fs").readdirSync>,
    );

    mockExistsSync.mockImplementation((p: string) => p.endsWith("/.git"));
    mockQueryRecentSessions.mockImplementation(() => Promise.resolve([]));

    // Only `registered-app` has a `projects` registry row; the other has none.
    mockGetRegistryIdsByNames.mockImplementation(() =>
      Promise.resolve(new Map<string, string>([["registered-app", "proj-123"]])),
    );

    const res = await handleGetDiscoveredProjects(db);
    expect(res.status).toBe(200);

    const body = (await res.json()) as {
      projects: Array<{ name: string; registryId: string | null }>;
    };

    const registered = body.projects.find((p) => p.name === "registered-app");
    const unregistered = body.projects.find((p) => p.name === "unregistered-app");

    expect(registered?.registryId).toBe("proj-123");
    expect(unregistered?.registryId).toBeNull();
  });
});
