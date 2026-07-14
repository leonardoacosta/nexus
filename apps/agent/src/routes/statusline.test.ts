/**
 * GET /statusline model-derivation tests (add-session-model-authority).
 *
 * The handler used to hardcode `model: null` for every session; it now derives
 * the single-letter family tag from the row's raw stored `model` via the shared
 * `modelFamilyLetter` in `@nexus/core`. These tests pin that response shape.
 *
 * `queryActiveSessions` is stubbed via a RESTORABLE `spyOn` (never mock.module —
 * avoids the process-global forward-leak class) so no DB is required, and
 * `execText` is stubbed so the module-level git-status cache never shells out to
 * the real `git` binary (it is irrelevant to the model assertion).
 */

import { describe, test, expect, spyOn, afterEach } from "bun:test";
import type { Db } from "@nexus/db";
import type { SessionRow } from "../db/sessions";
import * as sessionsDb from "../db/sessions";
import * as execMod from "../utils/exec";
import { handleStatusline } from "./statusline";

function makeRow(overrides: Partial<SessionRow>): SessionRow {
  return {
    id: "sess-1",
    projectId: "proj-uuid",
    status: "active",
    model: null,
    cwd: "/x",
    lastActivity: new Date(),
    ...overrides,
  } as unknown as SessionRow;
}

interface StatuslineBody {
  sessions: Array<{ id: string; model: string | null }>;
}

describe("GET /statusline — model letter derivation", () => {
  let qSpy: ReturnType<typeof spyOn<typeof sessionsDb, "queryActiveSessions">> | undefined;
  let execSpy: ReturnType<typeof spyOn<typeof execMod, "execText">> | undefined;

  afterEach(() => {
    qSpy?.mockRestore();
    execSpy?.mockRestore();
  });

  test("derives the family letter from the row's raw model (claude-opus-4-8 → O)", async () => {
    qSpy = spyOn(sessionsDb, "queryActiveSessions").mockResolvedValue([
      makeRow({ id: "s1", model: "claude-opus-4-8" }),
    ]);
    execSpy = spyOn(execMod, "execText").mockResolvedValue("");

    const res = await handleStatusline({} as Db, new URL("http://x/statusline"));
    const body = (await res.json()) as StatuslineBody;
    expect(body.sessions[0]!.model).toBe("O");
  });

  test("model stays null when the row has no stored model", async () => {
    qSpy = spyOn(sessionsDb, "queryActiveSessions").mockResolvedValue([
      makeRow({ id: "s2", model: null }),
    ]);
    execSpy = spyOn(execMod, "execText").mockResolvedValue("");

    const res = await handleStatusline({} as Db, new URL("http://x/statusline"));
    const body = (await res.json()) as StatuslineBody;
    expect(body.sessions[0]!.model).toBeNull();
  });
});
