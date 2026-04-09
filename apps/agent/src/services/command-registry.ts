/**
 * CommandRegistry — in-memory registry of Claude Code slash commands.
 *
 * Discovers commands from `~/.claude/commands/` on startup, caching them
 * in memory. Supports list/filter/get/update operations. Mirrors the
 * Rust agent's CommandRegistry behavior.
 *
 * Naming convention:
 *   ~/.claude/commands/apply.md          -> full_name = "apply"
 *   ~/.claude/commands/audit/code.md     -> full_name = "audit:code"
 *   ~/.claude/commands/plan/roadmap.md   -> full_name = "plan:roadmap"
 *
 * Excluded: `references/` directories, `README.md` files.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, basename, dirname, extname } from "node:path";
import { homedir } from "node:os";
import { createLogger } from "@nexus/core";

const log = createLogger("agent:services:command-registry");

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type CommandTier = "status" | "analysis" | "action";
export type CostCategory = "low" | "medium" | "high";

export interface CommandInfo {
  name: string;
  namespace: string;
  full_name: string;
  description: string;
  tier: CommandTier;
  cost: CostCategory;
}

// ---------------------------------------------------------------------------
// Static categorization
// ---------------------------------------------------------------------------

function categorize(fullName: string): { tier: CommandTier; cost: CostCategory } {
  switch (fullName) {
    // Status tier -- fast, read-only
    case "next":
    case "recon":
    case "workflow:check":
      return { tier: "status", cost: "low" };

    // Analysis tier -- longer running
    case "audit:code":
    case "audit:arch-review":
    case "audit:services":
    case "audit:arewedone":
    case "audit:preflight":
      return { tier: "analysis", cost: "high" };
    case "monitor:costs":
    case "monitor:triage":
      return { tier: "analysis", cost: "low" };
    case "monitor:sentry":
    case "monitor:logs":
    case "monitor:posthog":
      return { tier: "analysis", cost: "medium" };
    case "ci:gh":
      return { tier: "analysis", cost: "medium" };
    case "project:discover":
    case "project:explore":
      return { tier: "analysis", cost: "high" };

    // Action tier -- mutates state
    case "apply":
    case "apply:all":
      return { tier: "action", cost: "high" };
    case "feature":
      return { tier: "action", cost: "medium" };
    case "commit":
    case "p2p":
      return { tier: "action", cost: "medium" };
    case "test:e2e":
    case "test:fix-types":
    case "test:run-quality-gates":
      return { tier: "action", cost: "medium" };
    case "review:local":
      return { tier: "action", cost: "low" };

    // Default: analysis/medium (safe middle ground)
    default:
      return { tier: "analysis", cost: "medium" };
  }
}

// ---------------------------------------------------------------------------
// Scanning logic
// ---------------------------------------------------------------------------

/** Read the first non-empty line from a file, stripping a leading # prefix. */
function readDescription(filePath: string): string {
  try {
    const content = readFileSync(filePath, "utf8");
    const firstLine = content.split("\n").find((l) => l.trim() !== "") ?? "";
    return firstLine.trim().replace(/^#+\s*/, "");
  } catch {
    return "";
  }
}

/** Recursively scan a directory for .md command files. */
function scanDir(
  dir: string,
  base: string,
  commands: CommandInfo[],
): void {
  let rawEntries: string[];
  try {
    rawEntries = readdirSync(dir);
  } catch {
    return;
  }

  for (const entryName of rawEntries) {
    const fullPath = join(dir, entryName);

    let stat;
    try {
      stat = statSync(fullPath);
    } catch {
      continue;
    }

    if (stat.isDirectory()) {
      // Skip references/ directories.
      if (entryName === "references") continue;
      scanDir(fullPath, base, commands);
    } else if (stat.isFile()) {
      // Only process .md files; skip README.md.
      if (extname(entryName) !== ".md") continue;
      if (entryName.toLowerCase() === "readme.md") continue;

      // Derive namespace from relative path.
      const parent = dirname(fullPath);
      const relParent = relative(base, parent);
      const namespace = relParent ? relParent.split("/").join(":") : "";

      // Command name is file stem (without .md).
      const name = basename(entryName, ".md");
      if (!name) continue;

      const fullName = namespace ? `${namespace}:${name}` : name;
      const description = readDescription(fullPath);
      const { tier, cost } = categorize(fullName);

      commands.push({ name, namespace, full_name: fullName, description, tier, cost });
    }
  }
}

/** Scan a commands directory and return sorted CommandInfo[]. */
function scanCommands(dir: string): CommandInfo[] {
  try {
    statSync(dir);
  } catch {
    return [];
  }

  const commands: CommandInfo[] = [];
  scanDir(dir, dir, commands);

  // Sort: namespace first, then name.
  commands.sort((a, b) => {
    const nsCmp = a.namespace.localeCompare(b.namespace);
    return nsCmp !== 0 ? nsCmp : a.name.localeCompare(b.name);
  });

  log.debug({ count: commands.length, dir }, "command scan complete");
  return commands;
}

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

export class CommandRegistry {
  private commands: CommandInfo[] = [];
  private byName: Map<string, number> = new Map();
  private readonly commandsDir: string;

  constructor(commandsDir: string) {
    this.commandsDir = commandsDir;
    this.refresh();
  }

  /** Convenience constructor using ~/.claude/commands/. */
  static withDefaultDir(): CommandRegistry {
    const dir = join(homedir(), ".claude", "commands");
    return new CommandRegistry(dir);
  }

  /** Re-scan the commands directory and replace the cached list. */
  refresh(): void {
    this.commands = scanCommands(this.commandsDir);
    this.byName = new Map(
      this.commands.map((c, i) => [c.full_name, i]),
    );
  }

  /** List commands, optionally filtered by namespace and/or tier. */
  list(namespace?: string, tier?: string): CommandInfo[] {
    return this.commands.filter((c) => {
      if (namespace !== undefined && c.namespace !== namespace) return false;
      if (tier !== undefined && c.tier !== tier) return false;
      return true;
    });
  }

  /** Look up a command by full name (e.g., "audit:code"). */
  get(fullName: string): CommandInfo | undefined {
    const idx = this.byName.get(fullName);
    if (idx === undefined) return undefined;
    return this.commands[idx];
  }

  /**
   * Return the filesystem path for a command by full_name.
   * E.g., "audit:code" -> commandsDir/audit/code.md
   * Returns null if the file does not exist.
   */
  getPath(fullName: string): string | null {
    const parts = fullName.split(":");
    let path = this.commandsDir;
    for (const part of parts) {
      path = join(path, part);
    }
    path += ".md";

    try {
      statSync(path);
      return path;
    } catch {
      return null;
    }
  }

  /** Return the commands directory path. */
  getCommandsDir(): string {
    return this.commandsDir;
  }
}
