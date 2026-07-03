/**
 * CommandRegistry unit tests.
 *
 * Tests use a temporary directory with mock .md files to exercise
 * the registry's scan, list, filter, get, and getPath operations
 * without touching the real ~/.claude/commands/ directory.
 */

import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { CommandRegistry } from "./command-registry";
import { mkdirSync, writeFileSync, rmSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// ---------------------------------------------------------------------------
// Test fixture
// ---------------------------------------------------------------------------

const TEST_DIR = join(tmpdir(), `nexus-cmd-registry-test-${Date.now()}`);

function setupTestCommands(): void {
  // Root-level commands.
  writeFileSync(join(TEST_DIR, "apply.md"), "# Apply changes\nRun the apply workflow.");
  writeFileSync(join(TEST_DIR, "next.md"), "# Next action\nShow the next recommended action.");
  writeFileSync(join(TEST_DIR, "commit.md"), "# Commit\nCreate a git commit.");

  // Namespaced commands: audit/
  const auditDir = join(TEST_DIR, "audit");
  mkdirSync(auditDir, { recursive: true });
  writeFileSync(join(auditDir, "code.md"), "# Code audit\nRun code quality audit.");
  writeFileSync(join(auditDir, "arch-review.md"), "# Architecture review\nReview architecture.");

  // Namespaced commands: monitor/
  const monitorDir = join(TEST_DIR, "monitor");
  mkdirSync(monitorDir, { recursive: true });
  writeFileSync(join(monitorDir, "costs.md"), "# Cost monitoring\nCheck API costs.");
  writeFileSync(join(monitorDir, "sentry.md"), "# Sentry check\nCheck Sentry errors.");

  // Excluded: references/ directory should be skipped.
  const referencesDir = join(TEST_DIR, "references");
  mkdirSync(referencesDir, { recursive: true });
  writeFileSync(join(referencesDir, "hidden.md"), "# Should be excluded");

  // Excluded: README.md should be skipped.
  writeFileSync(join(TEST_DIR, "README.md"), "# Commands Reference\nThis should be excluded.");

  // Non-.md files should be skipped.
  writeFileSync(join(TEST_DIR, "notes.txt"), "not a command");
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe("CommandRegistry", () => {
  let registry: CommandRegistry;

  beforeAll(() => {
    mkdirSync(TEST_DIR, { recursive: true });
    setupTestCommands();
    registry = new CommandRegistry(TEST_DIR);
  });

  afterAll(() => {
    rmSync(TEST_DIR, { recursive: true, force: true });
  });

  // ── list() ──────────────────────────────────────────────────────────────

  it("discovers all .md command files", () => {
    const all = registry.list();
    // 3 root + 2 audit + 2 monitor = 7 commands.
    expect(all).toHaveLength(7);
  });

  it("excludes references/ directory", () => {
    const all = registry.list();
    const names = all.map((c) => c.full_name);
    expect(names).not.toContain("references:hidden");
  });

  it("excludes README.md files", () => {
    const all = registry.list();
    const names = all.map((c) => c.name);
    expect(names).not.toContain("README");
  });

  it("list() results are sorted by namespace then name", () => {
    const all = registry.list();
    const fullNames = all.map((c) => c.full_name);

    // Root commands (empty namespace) come first, then audit, then monitor.
    const rootIdx = fullNames.indexOf("apply");
    const auditIdx = fullNames.indexOf("audit:code");
    const monitorIdx = fullNames.indexOf("monitor:costs");

    expect(rootIdx).toBeLessThan(auditIdx);
    expect(auditIdx).toBeLessThan(monitorIdx);
  });

  // ── list() with namespace filter ────────────────────────────────────────

  it("list(namespace) filters by namespace", () => {
    const auditCmds = registry.list("audit");
    expect(auditCmds).toHaveLength(2);

    const names = auditCmds.map((c) => c.full_name).sort();
    expect(names).toEqual(["audit:arch-review", "audit:code"]);
  });

  it("list(namespace) for root commands uses empty string", () => {
    const rootCmds = registry.list("");
    expect(rootCmds).toHaveLength(3);

    const names = rootCmds.map((c) => c.full_name).sort();
    expect(names).toEqual(["apply", "commit", "next"]);
  });

  it("list(namespace) returns empty for unknown namespace", () => {
    const result = registry.list("nonexistent");
    expect(result).toHaveLength(0);
  });

  // ── list() with tier filter ─────────────────────────────────────────────

  it("list(undefined, tier) filters by tier", () => {
    const statusCmds = registry.list(undefined, "status");
    const statusNames = statusCmds.map((c) => c.full_name);
    expect(statusNames).toContain("next");
  });

  it("list(namespace, tier) applies both filters", () => {
    const result = registry.list("audit", "analysis");
    const names = result.map((c) => c.full_name);
    expect(names).toContain("audit:code");
    expect(names).toContain("audit:arch-review");
  });

  // ── get() ───────────────────────────────────────────────────────────────

  it("get() returns command by full_name", () => {
    const cmd = registry.get("audit:code");
    expect(cmd).toBeDefined();
    expect(cmd!.name).toBe("code");
    expect(cmd!.namespace).toBe("audit");
    expect(cmd!.full_name).toBe("audit:code");
  });

  it("get() returns root command", () => {
    const cmd = registry.get("apply");
    expect(cmd).toBeDefined();
    expect(cmd!.name).toBe("apply");
    expect(cmd!.namespace).toBe("");
  });

  it("get() returns undefined for unknown command", () => {
    const cmd = registry.get("does-not-exist");
    expect(cmd).toBeUndefined();
  });

  // ── Command metadata ───────────────────────────────────────────────────

  it("extracts description from first line of file", () => {
    const cmd = registry.get("apply");
    expect(cmd).toBeDefined();
    // First line is "# Apply changes" -> description = "Apply changes"
    expect(cmd!.description).toBe("Apply changes");
  });

  it("assigns tier and cost from categorize()", () => {
    const apply = registry.get("apply");
    expect(apply!.tier).toBe("action");
    expect(apply!.cost).toBe("high");

    const next = registry.get("next");
    expect(next!.tier).toBe("status");
    expect(next!.cost).toBe("low");

    const auditCode = registry.get("audit:code");
    expect(auditCode!.tier).toBe("analysis");
    expect(auditCode!.cost).toBe("high");
  });

  // ── getPath() ──────────────────────────────────────────────────────────

  it("getPath() returns filesystem path for known command", () => {
    const path = registry.getPath("apply");
    expect(path).toBe(join(TEST_DIR, "apply.md"));
  });

  it("getPath() returns path for namespaced command", () => {
    const path = registry.getPath("audit:code");
    expect(path).toBe(join(TEST_DIR, "audit", "code.md"));
  });

  it("getPath() returns null for unknown command", () => {
    const path = registry.getPath("nonexistent:command");
    expect(path).toBeNull();
  });

  // ── refresh() ──────────────────────────────────────────────────────────

  it("refresh() picks up new files", () => {
    // Add a new command file.
    writeFileSync(join(TEST_DIR, "review.md"), "# Review\nCode review command.");

    const countBefore = registry.list().length;
    registry.refresh();
    const countAfter = registry.list().length;

    expect(countAfter).toBe(countBefore + 1);

    const cmd = registry.get("review");
    expect(cmd).toBeDefined();
    expect(cmd!.description).toBe("Review");
  });

  it("refresh() removes deleted files", () => {
    // Remove the review command we just added.
    unlinkSync(join(TEST_DIR, "review.md"));

    registry.refresh();

    const cmd = registry.get("review");
    expect(cmd).toBeUndefined();
  });

  // ── getCommandsDir() ──────────────────────────────────────────────────

  it("getCommandsDir() returns the configured directory", () => {
    expect(registry.getCommandsDir()).toBe(TEST_DIR);
  });

  // ── Empty directory ────────────────────────────────────────────────────

  it("handles empty directory gracefully", () => {
    const emptyDir = join(tmpdir(), `nexus-cmd-empty-${Date.now()}`);
    mkdirSync(emptyDir, { recursive: true });

    const emptyRegistry = new CommandRegistry(emptyDir);
    expect(emptyRegistry.list()).toHaveLength(0);
    expect(emptyRegistry.get("anything")).toBeUndefined();

    rmSync(emptyDir, { recursive: true, force: true });
  });

  it("handles nonexistent directory gracefully", () => {
    const noDir = join(tmpdir(), `nexus-cmd-nodir-${Date.now()}`);
    const noRegistry = new CommandRegistry(noDir);
    expect(noRegistry.list()).toHaveLength(0);
  });
});
