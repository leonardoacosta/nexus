/**
 * Integration test: .audit-suppressions.json regression guard.
 *
 * Proves the repo-root suppression config is producing the intended effect on
 * `audit-scan` output. Tasks 4.1–4.4 added suppression support and shipped the
 * config; this test asserts the config actually reduces the D4 (spawn-call)
 * finding set to the expected short list of unsuppressed production sites, and
 * that both suppression code paths (config-driven + auto test skip) are firing.
 *
 * Why this lives here:
 *   The suppression file is a repo-root governance artifact that anyone can
 *   touch. Without a test, a careless edit (typo in glob, deleted stanza) can
 *   silently re-surface hundreds of known-safe spawn sites or — worse — hide
 *   a newly-introduced insecure site. This test pins the numbers so both
 *   directions are caught in CI.
 *
 * Requirements:
 *   The `audit-scan` binary lives at `~/.claude/scripts/bin/audit-scan` on dev
 *   boxes. If it is missing (fresh checkout, CI without the Claude harness),
 *   the suite skips gracefully rather than failing.
 *
 * Environment override:
 *   Set `AUDIT_SCAN_BIN` to point at a different audit-scan path. Useful when
 *   CI vendors a pinned copy of the script instead of relying on the user's
 *   home directory.
 */

import { describe, test, expect } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

// ---------------------------------------------------------------------------
// Environment probe
// ---------------------------------------------------------------------------

/** Absolute path to the repo root (packages/core/src → <repo>). */
const REPO_ROOT = resolve(import.meta.dir, "..", "..", "..");

/** Resolve the audit-scan binary. Env var wins; otherwise use the Claude home path. */
const AUDIT_SCAN_BIN =
  process.env.AUDIT_SCAN_BIN ??
  join(homedir(), ".claude", "scripts", "bin", "audit-scan");

/** Skip the suite cleanly if the binary isn't present on this machine. */
const AUDIT_SCAN_AVAILABLE = existsSync(AUDIT_SCAN_BIN);

// ---------------------------------------------------------------------------
// Expected outputs after suppressions
// ---------------------------------------------------------------------------

/**
 * Expected remaining D4 sites after all suppressions have been applied.
 *
 * These are the production spawn callers that the spec deliberately leaves
 * unsuppressed — either because they are the safeSpawn wrapper itself
 * (self-reference is expected) or because they are low-risk infra helpers
 * (tailscale lookup, nexus-status git probe) that haven't been migrated yet
 * and may never need migration.
 *
 * If a new spawn call appears in production code, it MUST either:
 *   1. Be migrated to safeSpawn (preferred), or
 *   2. Be added to .audit-suppressions.json with a justification, or
 *   3. Be added to this list with a comment explaining why.
 *
 * Flipping one of those decisions is the only way this test should change.
 */
const EXPECTED_UNSUPPRESSED_D4_FILES = new Set<string>([
  // The safeSpawn wrapper itself calls Bun.spawn — D4 pattern match hits the
  // implementation, which is by definition the sanctioned spawn site.
  "packages/core/src/safe-spawn.ts",
  // nexus-status is a standalone CLI that reads git state via execSync with
  // constant command strings. Not routed through safeSpawn because it has no
  // user-supplied input surface.
  "apps/nexus-status/src/index.ts",
  // Tailscale IP lookup in the agent's DB registry — constant args, boots
  // once at startup. Candidate for future safeSpawn migration.
  "apps/agent/src/db/agent-registry.ts",
]);

/** Upper bound on D4 findings after suppressions. Pinned to today's baseline. */
const D4_FINDINGS_CEILING = 6;

// ---------------------------------------------------------------------------
// Types — partial shape of audit-scan --json output we depend on
// ---------------------------------------------------------------------------

interface AuditFinding {
  id: string;
  severity: string;
  category: string;
  file: string;
  line: number;
  message: string;
}

interface AuditSuppressions {
  by_config: number;
  by_auto_test_skip: number;
  total: number;
}

interface AuditReport {
  findings: AuditFinding[];
  suppressions: AuditSuppressions;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Run audit-scan against the repo and return the parsed JSON report. Uses
 * spawnSync so the test remains synchronous and easy to reason about — the
 * scan takes ~1–2s, well inside any reasonable test timeout.
 */
function runAuditScan(): AuditReport {
  const result = spawnSync(
    AUDIT_SCAN_BIN,
    ["--project", REPO_ROOT, "--json"],
    { encoding: "utf-8", timeout: 60_000 },
  );

  if (result.status !== 0) {
    throw new Error(
      `audit-scan failed (exit ${result.status}): ${result.stderr || "(no stderr)"}`,
    );
  }

  return JSON.parse(result.stdout) as AuditReport;
}

/** Filter helper: all findings matching a given check id. */
function findingsWithId(report: AuditReport, id: string): AuditFinding[] {
  return report.findings.filter((f) => f.id === id);
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe.skipIf(!AUDIT_SCAN_AVAILABLE)(
  "audit-suppressions — D4 regression guard",
  () => {
    test(".audit-suppressions.json exists and is well-formed", () => {
      const configPath = join(REPO_ROOT, ".audit-suppressions.json");
      expect(existsSync(configPath)).toBe(true);

      const parsed = JSON.parse(readFileSync(configPath, "utf-8")) as {
        suppressions: Array<{ id: string; paths: string[]; reason: string }>;
        autoSkipTestFiles: string[];
      };

      // Every stanza must have id, paths, reason. The CI lint
      // (scripts/validate-audit-suppressions.sh) enforces this too; duplicated
      // here so a broken config fails the test suite even if CI is skipped.
      expect(Array.isArray(parsed.suppressions)).toBe(true);
      expect(parsed.suppressions.length).toBeGreaterThan(0);
      for (const s of parsed.suppressions) {
        expect(typeof s.id).toBe("string");
        expect(s.id.length).toBeGreaterThan(0);
        expect(Array.isArray(s.paths)).toBe(true);
        expect(s.paths.length).toBeGreaterThan(0);
        expect(typeof s.reason).toBe("string");
        expect(s.reason.trim().length).toBeGreaterThan(0);
      }

      // autoSkipTestFiles must include D4 — otherwise the 101 test-file
      // spawn calls in bun tests would flood the findings list.
      expect(parsed.autoSkipTestFiles).toContain("D4");
    });

    test("config-driven suppressions are firing (suppressions.by_config > 0)", () => {
      const report = runAuditScan();
      // Proves the .audit-suppressions.json reader is wired in and matching
      // at least one site. A zero here means the config file was silently
      // ignored (wrong path, parse error handled too leniently, etc).
      expect(report.suppressions.by_config).toBeGreaterThan(0);
    });

    test("auto test-file skip is firing (suppressions.by_auto_test_skip > 0)", () => {
      const report = runAuditScan();
      // Proves the autoSkipTestFiles glob matcher is running. The baseline
      // is ~100 test-file D4 hits; any non-zero number confirms the path
      // works, but we assert >> 0 to catch a misbehaving matcher that only
      // skips one or two incidentally.
      expect(report.suppressions.by_auto_test_skip).toBeGreaterThan(10);
    });

    test("remaining D4 finding count is at or below the expected ceiling", () => {
      const report = runAuditScan();
      const d4 = findingsWithId(report, "D4");

      // The ceiling protects against regressions: if someone adds a new
      // raw spawn/exec call in production without migrating it to safeSpawn
      // or suppressing it, this assert will fire. Current baseline is 5
      // (safe-spawn wrapper itself + 3 nexus-status git probes + 1 agent
      // tailscale lookup). We allow one extra slot to avoid flakiness from
      // minor rg/glob version differences.
      expect(d4.length).toBeLessThanOrEqual(D4_FINDINGS_CEILING);
    });

    test("every remaining D4 finding is in the expected unsuppressed file set", () => {
      const report = runAuditScan();
      const d4 = findingsWithId(report, "D4");

      // Collect the distinct files that still produce D4 hits. If a new
      // file appears here, the test fails with a clear diff so the
      // reviewer can decide: migrate to safeSpawn, suppress, or allow.
      const actualFiles = new Set(d4.map((f) => f.file));
      const unexpected = [...actualFiles].filter(
        (file) => !EXPECTED_UNSUPPRESSED_D4_FILES.has(file),
      );

      expect(unexpected).toEqual([]);
    });

    test("suppressed production paths from .audit-suppressions.json do NOT appear in D4 findings", () => {
      const report = runAuditScan();
      const d4Files = new Set(findingsWithId(report, "D4").map((f) => f.file));

      // These paths are explicitly listed in .audit-suppressions.json. If
      // any of them reappear in findings, the path-match logic has
      // regressed and the suppression is being silently ignored.
      const mustBeSuppressed = [
        "apps/agent/src/terminal/pty-source.ts",
        "apps/agent/src/watcher-bridge.ts",
        "apps/agent/src/utils/exec.ts",
        "apps/agent/src/routes/projects-discovered.ts",
      ];

      for (const path of mustBeSuppressed) {
        expect(d4Files.has(path)).toBe(false);
      }
    });
  },
);
