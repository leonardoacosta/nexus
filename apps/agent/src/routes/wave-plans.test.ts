/**
 * Contract tests for GET /wave-plans/active.
 *
 * Added by `specs-tab-accordion-with-topology` (task 1.5). Verifies:
 *   (a) Valid active plan projects into the wire shape with all specs flattened.
 *   (b) Missing active.txt returns the full empty payload (no `error` key).
 *   (c) Malformed wave-plan.json returns 200 with `error` field embedded.
 *   (d) Status enum normalization maps legacy values + falls back safely.
 *   (e) currentWave inference threads through correctly when waves[].wave_number set.
 *
 * Uses real tmpdir fixtures (mirroring specs-payload-completeness.test.ts) —
 * the handler resolves the repo root from `NEXUS_REPO_ROOT` so we pin it to
 * the fixture root per test.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  handleGetActiveWavePlan,
  loadActiveWavePlan,
  normalizeSpecStatus,
  projectWavePlan,
  type WavePlanPayload,
} from "./wave-plans";

let repoRoot: string;
let savedEnv: string | undefined;

beforeEach(() => {
  repoRoot = mkdtempSync(join(tmpdir(), "nx-wave-plans-"));
  mkdirSync(join(repoRoot, "docs", "apply"), { recursive: true });
  savedEnv = process.env.NEXUS_REPO_ROOT;
  process.env.NEXUS_REPO_ROOT = repoRoot;
});

afterEach(() => {
  rmSync(repoRoot, { recursive: true, force: true });
  if (savedEnv === undefined) {
    delete process.env.NEXUS_REPO_ROOT;
  } else {
    process.env.NEXUS_REPO_ROOT = savedEnv;
  }
});

// ---------------------------------------------------------------------------
// Fixture builder
// ---------------------------------------------------------------------------

function writeActivePlan(runId: string, planJson: unknown): void {
  writeFileSync(join(repoRoot, "docs", "apply", "active.txt"), `${runId}\n`);
  const runDir = join(repoRoot, "docs", "apply", runId);
  mkdirSync(runDir, { recursive: true });
  writeFileSync(
    join(runDir, "wave-plan.json"),
    typeof planJson === "string" ? planJson : JSON.stringify(planJson),
  );
}

// ---------------------------------------------------------------------------
// (a) Valid active plan returns full projection
// ---------------------------------------------------------------------------

describe("handleGetActiveWavePlan — valid active plan", () => {
  it("flattens waves[].specs[] into specStatuses[] and threads top-level fields", async () => {
    writeActivePlan("apply-2026-05-19-001", {
      plan_id: "apply-2026-05-19-001",
      status: "in_progress",
      current_wave: 3,
      current_phase: "API",
      waves: [
        {
          wave_number: 1,
          specs: [
            {
              name: "collapse-credentials-dir",
              status: "merged",
              phase_classification: "P1",
              dispatched_at: "2026-05-19T18:00:00.000Z",
            },
            {
              name: "add-cc-credential-manager",
              status: "completed",
              phase_classification: "P4",
              dispatched_at: null,
            },
          ],
        },
        {
          wave_number: 3,
          specs: [
            {
              name: "specs-tab-accordion-with-topology",
              status: "in_progress",
              phase_classification: "API",
              dispatched_at: "2026-05-19T20:00:00.000Z",
            },
          ],
        },
      ],
    });

    const res = await handleGetActiveWavePlan();
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("application/json");

    const body = (await res.json()) as WavePlanPayload;
    expect(body.runId).toBe("apply-2026-05-19-001");
    expect(body.planName).toBe("apply-2026-05-19-001");
    expect(body.status).toBe("in_progress");
    expect(body.currentWave).toBe(3);
    expect(body.currentPhase).toBe("API");
    expect(body.error).toBeUndefined();

    expect(body.specStatuses).toHaveLength(3);
    expect(body.specStatuses[0]).toEqual({
      name: "collapse-credentials-dir",
      wave: 1,
      status: "completed", // legacy "merged" normalized
      phase: "P1",
      dispatchedAt: "2026-05-19T18:00:00.000Z",
    });
    expect(body.specStatuses[2]).toEqual({
      name: "specs-tab-accordion-with-topology",
      wave: 3,
      status: "in_progress",
      phase: "API",
      dispatchedAt: "2026-05-19T20:00:00.000Z",
    });
  });
});

// ---------------------------------------------------------------------------
// (b) Missing active.txt returns empty payload (no error key)
// ---------------------------------------------------------------------------

describe("handleGetActiveWavePlan — missing active.txt", () => {
  it("returns the full empty shape with no error field", async () => {
    // docs/apply/ exists but no active.txt
    const res = await handleGetActiveWavePlan();
    expect(res.status).toBe(200);
    const body = (await res.json()) as WavePlanPayload;
    expect(body).toEqual({
      runId: null,
      planName: null,
      status: null,
      currentWave: null,
      currentPhase: null,
      specStatuses: [],
    });
    expect(body.error).toBeUndefined();
  });

  it("returns empty payload when active.txt is empty whitespace", async () => {
    writeFileSync(join(repoRoot, "docs", "apply", "active.txt"), "   \n");
    const res = await handleGetActiveWavePlan();
    const body = (await res.json()) as WavePlanPayload;
    expect(body.runId).toBeNull();
    expect(body.specStatuses).toEqual([]);
    expect(body.error).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// (c) Malformed JSON returns 200 with embedded error
// ---------------------------------------------------------------------------

describe("handleGetActiveWavePlan — malformed wave-plan.json", () => {
  it("returns 200 with embedded error field on JSON parse failure", async () => {
    writeActivePlan("apply-2026-05-19-bad", "{not-valid-json");
    const res = await handleGetActiveWavePlan();
    expect(res.status).toBe(200);
    const body = (await res.json()) as WavePlanPayload;
    expect(body.runId).toBeNull();
    expect(body.specStatuses).toEqual([]);
    expect(typeof body.error).toBe("string");
    expect(body.error).toContain("malformed wave-plan.json");
  });

  it("returns embedded error when wave-plan.json is missing for run-id", async () => {
    writeFileSync(join(repoRoot, "docs", "apply", "active.txt"), "ghost-run\n");
    // Intentionally do not create docs/apply/ghost-run/wave-plan.json
    const res = await handleGetActiveWavePlan();
    const body = (await res.json()) as WavePlanPayload;
    expect(body.runId).toBeNull();
    expect(typeof body.error).toBe("string");
    expect(body.error).toContain("failed to read wave-plan.json");
  });
});

// ---------------------------------------------------------------------------
// (d) Status enum normalization
// ---------------------------------------------------------------------------

describe("normalizeSpecStatus — legacy + unknown mapping", () => {
  it("maps canonical values through unchanged", () => {
    expect(normalizeSpecStatus("queued")).toBe("queued");
    expect(normalizeSpecStatus("dispatched")).toBe("dispatched");
    expect(normalizeSpecStatus("in_progress")).toBe("in_progress");
    expect(normalizeSpecStatus("completed")).toBe("completed");
    expect(normalizeSpecStatus("failed")).toBe("failed");
    expect(normalizeSpecStatus("skipped")).toBe("skipped");
  });

  it("maps legacy values to canonical equivalents", () => {
    expect(normalizeSpecStatus("pending")).toBe("queued");
    expect(normalizeSpecStatus("done")).toBe("completed");
    expect(normalizeSpecStatus("merged")).toBe("completed");
    expect(normalizeSpecStatus("error")).toBe("failed");
  });

  it("falls back to queued for unknown / non-string inputs", () => {
    expect(normalizeSpecStatus("totally-unknown")).toBe("queued");
    expect(normalizeSpecStatus(undefined)).toBe("queued");
    expect(normalizeSpecStatus(null)).toBe("queued");
    expect(normalizeSpecStatus(42)).toBe("queued");
  });

  it("normalizes upper-case input", () => {
    expect(normalizeSpecStatus("COMPLETED")).toBe("completed");
    expect(normalizeSpecStatus("In_Progress")).toBe("in_progress");
  });
});

// ---------------------------------------------------------------------------
// (e) currentWave inference threads through correctly
// ---------------------------------------------------------------------------

describe("projectWavePlan — currentWave inference + wave-number threading", () => {
  it("uses top-level current_wave verbatim and threads wave_number per spec", () => {
    const payload = projectWavePlan(
      {
        plan_id: "apply-test-001",
        status: "in_progress",
        current_wave: 7,
        current_phase: null,
        waves: [
          { wave_number: 1, specs: [{ name: "alpha", status: "completed" }] },
          { wave_number: 7, specs: [{ name: "beta", status: "dispatched" }] },
          { wave_number: 9, specs: [{ name: "gamma", status: "queued" }] },
        ],
      },
      "apply-test-001",
    );
    expect(payload.currentWave).toBe(7);
    expect(payload.currentPhase).toBeNull();
    expect(payload.specStatuses).toHaveLength(3);
    const byName = Object.fromEntries(
      payload.specStatuses.map((s) => [s.name, s.wave] as const),
    );
    expect(byName.alpha).toBe(1);
    expect(byName.beta).toBe(7);
    expect(byName.gamma).toBe(9);
  });

  it("returns currentWave=null when top-level field is missing", () => {
    const payload = projectWavePlan(
      { plan_id: "x", waves: [{ wave_number: 2, specs: [] }] },
      "x",
    );
    expect(payload.currentWave).toBeNull();
  });

  it("end-to-end via handler: currentWave threads from disk JSON to response", async () => {
    writeActivePlan("apply-current-wave-test", {
      plan_id: "apply-current-wave-test",
      current_wave: 4,
      current_phase: "UI",
      waves: [{ wave_number: 4, specs: [{ name: "lone", status: "queued" }] }],
    });
    const res = await handleGetActiveWavePlan();
    const body = (await res.json()) as WavePlanPayload;
    expect(body.currentWave).toBe(4);
    expect(body.currentPhase).toBe("UI");
    expect(body.specStatuses[0]?.wave).toBe(4);
  });
});

// ---------------------------------------------------------------------------
// Defensive: loadActiveWavePlan with a non-existent repo root
// ---------------------------------------------------------------------------

describe("loadActiveWavePlan — non-existent repo root", () => {
  it("treats missing docs/apply as empty (no active run)", async () => {
    const fakeRoot = join(repoRoot, "no-such-dir");
    const payload = await loadActiveWavePlan(fakeRoot);
    expect(payload.runId).toBeNull();
    expect(payload.specStatuses).toEqual([]);
    expect(payload.error).toBeUndefined();
  });
});
