/**
 * Shared test helpers for projects-discovered test files.
 *
 * Provides mock setup and the Dirent builder used across all split files.
 *
 * NOTE: We DO NOT use `mock.module("node:fs", ...)` because Bun's module mocks
 * are process-global and irreversible — they leak into unrelated test files
 * (command-registry, line-count, config-loader, etc.) and corrupt their
 * `readdirSync` calls. Instead, projects-discovered.ts exposes an injectable
 * fs shim via __setFsForTesting / __resetFsForTesting which is scoped to the
 * module under test.
 */

import { mock } from "bun:test";
import type { Db } from "@nexus/db";
import {
  __setFsForTesting,
  __setDepsForTesting,
  __setGitRemoteResolverForTesting,
} from "./projects-discovered";

// ── Mocks for the injectable fs shim and db deps ──────────────────────────────

export const mockReaddirSync = mock(() => [] as ReturnType<typeof import("node:fs").readdirSync>);
export const mockExistsSync = mock((_p: string) => false);
export const mockRealpathSync = mock((p: string) => p);

// Install the fs shim. This is scoped to projects-discovered.ts only.
__setFsForTesting({
  readdirSync: mockReaddirSync as unknown as typeof import("node:fs").readdirSync,
  existsSync: mockExistsSync as unknown as typeof import("node:fs").existsSync,
  realpathSync: mockRealpathSync as unknown as typeof import("node:fs").realpathSync,
});

export const mockQueryRecentSessions = mock((): Promise<{ id: string; project: string; machine: string; status: string; startedAt: Date; lastActivity: Date; endedAt: Date | null; pid: number | null; cwd: string | null }[]> => Promise.resolve([]));

export const mockUpsertProjectLocations = mock((): Promise<void> => Promise.resolve());

// Install db deps shim. Scoped to projects-discovered.ts only.
__setDepsForTesting({
  queryRecentSessions: mockQueryRecentSessions as unknown as typeof import("../db/sessions").queryRecentSessions,
  upsertProjectLocations: mockUpsertProjectLocations as unknown as typeof import("../db/project-registry").upsertProjectLocations,
});

// Install the git-remote resolver shim. Defaults to null so real `git` is
// never spawned in the suite (existing tests never assert a non-null remote).
export const mockResolveGitRemote =
  mock((_p: string): Promise<string | null> => Promise.resolve(null));
__setGitRemoteResolverForTesting(
  mockResolveGitRemote as unknown as (p: string) => Promise<string | null>,
);


// ── Helpers ───────────────────────────────────────────────────────────────────

/** Build a minimal mock Db whose select chain returns the supplied rows. */
export function makeDb(rows: unknown[]): Db {
  return {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: () => Promise.resolve(rows),
        }),
      }),
    }),
  } as unknown as Db;
}

/** Build a Dirent-like object for use as a readdirSync entry. */
export function dirent(name: string, isDir: boolean) {
  return { name, isDirectory: () => isDir };
}

/** Standard agent row fixture. */
export function makeAgentRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "test-host",
    name: "test-host",
    host: "test-host",
    port: 7400,
    projectsDir: "/home/user/test-projects",
    enabled: true,
    lastSeen: null,
    createdAt: null,
    ...overrides,
  };
}

/** Reset all mocks to their default (safe) implementations. */
export function resetMocks() {
  mockReaddirSync.mockImplementation(() => []);
  mockExistsSync.mockImplementation(() => false);
  mockRealpathSync.mockImplementation((p: string) => p);
  mockQueryRecentSessions.mockImplementation(() => Promise.resolve([]));
  mockUpsertProjectLocations.mockImplementation(() => Promise.resolve());
  mockResolveGitRemote.mockImplementation(() => Promise.resolve(null));
}
