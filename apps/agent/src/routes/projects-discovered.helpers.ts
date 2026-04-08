/**
 * Shared test helpers for projects-discovered test files.
 *
 * Provides mock setup and the Dirent builder used across all split files.
 */

import { beforeEach, mock } from "bun:test";
import type { Db } from "@nexus/db";

// ── Module mocks (must be declared before importing the unit under test) ──────

export const mockReaddirSync = mock(() => [] as ReturnType<typeof import("node:fs").readdirSync>);
export const mockExistsSync = mock((_p: string) => false);
export const mockRealpathSync = mock((p: string) => p);

mock.module("node:fs", () => ({
  readdirSync: mockReaddirSync,
  existsSync: mockExistsSync,
  realpathSync: mockRealpathSync,
  default: {
    readdirSync: mockReaddirSync,
    existsSync: mockExistsSync,
    realpathSync: mockRealpathSync,
  },
}));

export const mockQueryRecentSessions = mock((): Promise<{ id: string; project: string; machine: string; status: string; startedAt: string; lastActivity: string; endedAt: string | null; pid: number | null; cwd: string | null }[]> => Promise.resolve([]));

mock.module("../db/sessions", () => ({
  queryRecentSessions: mockQueryRecentSessions,
}));

export const mockUpsertProjectLocations = mock((): Promise<void> => Promise.resolve());

mock.module("../db/project-registry", () => ({
  upsertProjectLocations: mockUpsertProjectLocations,
}));

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
}
