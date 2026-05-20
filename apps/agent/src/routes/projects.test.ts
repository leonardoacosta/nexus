/**
 * Contract test for GET /projects emission shape.
 *
 * Added by `agent-payload-completeness` (task 1.9). Pins the `hidden`
 * boolean on every row — both registry-backed and synthetic — so the
 * Swift `ProjectAggregate` decoder's required-field contract has a
 * matching agent-side guarantee.
 *
 * Pure-function test against `aggregateProjects` — no PG required.
 */

import { describe, it, expect } from "bun:test";
import { aggregateProjects } from "./projects";
import type { SessionRow } from "../db/sessions";

const REG_ID_VISIBLE = "11111111-1111-1111-1111-111111111111";
const REG_ID_HIDDEN = "22222222-2222-2222-2222-222222222222";

function session(over: Partial<SessionRow>): SessionRow {
  return {
    projectId: null,
    status: "active",
    machine: "host-a",
    ...over,
  } as unknown as SessionRow;
}

describe("aggregateProjects — hidden emission (agent-payload-completeness)", () => {
  it("emits hidden=true for a registry row marked hidden", () => {
    const rows = aggregateProjects(
      [session({ projectId: REG_ID_HIDDEN, machine: "host-a" })],
      [{ projectId: REG_ID_HIDDEN, name: "hidden-one", hidden: true }],
    );
    const row = rows.find((r) => r.name === "hidden-one");
    expect(row).toBeDefined();
    expect(row!.hidden).toBe(true);
  });

  it("emits hidden=false for a registry row marked visible", () => {
    const rows = aggregateProjects(
      [],
      [{ projectId: REG_ID_VISIBLE, name: "alpha", hidden: false }],
    );
    const row = rows.find((r) => r.name === "alpha");
    expect(row).toBeDefined();
    expect(row!.hidden).toBe(false);
  });

  it("emits hidden=false on the synthetic (unregistered) bucket", () => {
    const rows = aggregateProjects(
      [session({ projectId: null, machine: "host-b" })],
      [],
    );
    const unreg = rows.find((r) => r.name === "(unregistered)");
    expect(unreg).toBeDefined();
    expect(unreg!.hidden).toBe(false);
  });

  it("defaults hidden=false when a registry row omits the field (legacy callers)", () => {
    const rows = aggregateProjects(
      [],
      // `hidden` deliberately omitted to model an older callsite.
      [{ projectId: REG_ID_VISIBLE, name: "legacy" }],
    );
    const row = rows.find((r) => r.name === "legacy");
    expect(row!.hidden).toBe(false);
  });

  it("every emitted row has `hidden` set (no undefined leakage)", () => {
    const rows = aggregateProjects(
      [
        session({ projectId: REG_ID_VISIBLE, machine: "host-a" }),
        session({ projectId: null, machine: "host-b" }),
      ],
      [
        { projectId: REG_ID_VISIBLE, name: "alpha", hidden: false },
        { projectId: REG_ID_HIDDEN, name: "zeta", hidden: true },
      ],
    );
    for (const row of rows) {
      expect(typeof row.hidden).toBe("boolean");
    }
  });
});
