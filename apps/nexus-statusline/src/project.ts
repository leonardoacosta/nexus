import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, basename } from "node:path";

export function deriveProjectCode(dir: string): string {
  if (dir.includes("/.claude") || dir.endsWith("/.claude")) return "cc";
  const devIdx = dir.indexOf("/dev/");
  if (devIdx !== -1) {
    const rest = dir.slice(devIdx + 5);
    const end = rest.indexOf("/");
    return end !== -1 ? rest.slice(0, end) : rest;
  }
  return basename(dir) || "?";
}

// ── B&B project gate (radar content) ─────────────────────────────────────────

/** B&B fleet project codes — allowlist fallback when no project.toml `org` key. */
const BB_ALLOWLIST: ReadonlySet<string> = new Set([
  "ws", "fb", "dc", "se", "tb", "sc", "ba", "bo", "es", "ew", "ic", "lu", "pp",
]);

/**
 * Is this project part of the B&B fleet? `<projectDir>/.claude/project.toml`
 * `[project].org` is authoritative when present (`"bb"` = B&B); otherwise fall
 * back to the hardcoded allowlist matched against the derived project code.
 * Same no-TOML-dep regex approach as `getLocalAgentUrl`. All reads wrapped —
 * never throws; unreadable/absent toml + unlisted code → non-B&B (radar hidden
 * by default; a false-hide is low-cost, a false-show on a personal repo is not).
 */
export function isBbProject(projectDir: string): boolean {
  try {
    const tomlPath = join(projectDir, ".claude/project.toml");
    const content = readFileSync(tomlPath, "utf-8");
    const orgMatch = content.match(/^\s*org\s*=\s*["']([^"']+)["']/m);
    if (orgMatch) return orgMatch[1] === "bb";
  } catch {
    // No toml / unreadable — fall through to allowlist
  }
  try {
    return BB_ALLOWLIST.has(deriveProjectCode(projectDir));
  } catch {
    return false;
  }
}

/**
 * Strip the exact `radar:stale` token from each comma-CSV row of a pulse line,
 * dropping any row that becomes empty. Rows without the token pass through.
 */
export function stripRadarStale(line: string): string {
  return line
    .split("\n")
    .map((row) => {
      if (!row.includes("radar:stale")) return row;
      return row
        .split(",")
        .map((t) => t.trim())
        .filter((t) => t.length > 0 && t !== "radar:stale")
        .join(",");
    })
    .filter((row) => row.length > 0)
    .join("\n");
}

/**
 * Apply the B&B gate to a cached pulse line: B&B renders verbatim; non-B&B has
 * the `radar:stale` token stripped (line dropped entirely if it becomes empty).
 */
export function gatePulseLine(line: string | null, isBb: boolean): string | null {
  if (line == null) return null;
  if (isBb) return line;
  const stripped = stripRadarStale(line);
  return stripped.length > 0 ? stripped : null;
}

/** Parse agent URL from agents.toml (simple regex, no TOML dep). */
export function getLocalAgentUrl(): string {
  try {
    const tomlPath = join(homedir(), ".config/nexus/agents.toml");
    const content = readFileSync(tomlPath, "utf-8");
    // Find the first [[agents]] block with name matching self_name or "localhost"
    const selfMatch = content.match(/^self_name\s*=\s*"([^"]+)"/m);
    const selfName = selfMatch?.[1] ?? "localhost";

    // Find port for local agent (first agent block, or matching self_name)
    const portMatch = content.match(/port\s*=\s*(\d+)/);
    const port = portMatch?.[1] ?? "7400";

    return `http://localhost:${port}`;
  } catch {
    return "http://localhost:7400";
  }
}
