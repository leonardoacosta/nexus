/**
 * git-project — resolve git origin metadata for a working directory.
 *
 * Spec: openspec/changes/add-git-project-resolver
 *
 * Given a cwd, parses `git remote get-url origin` and extracts:
 *   - provider host  (github.com, gitlab.com, ...)
 *   - owner/repo     (leonardoacosta/nexus)
 *
 * Supported URL forms:
 *   1. SSH:    git@github.com:leonardoacosta/nexus.git
 *   2. HTTPS:  https://github.com/leonardoacosta/nexus.git
 *   3. Git:    git://github.com/leonardoacosta/nexus
 *
 * Returns `null` for non-git directories, missing origin, or malformed URLs.
 * Never throws — fire-and-forget call site in handleSessionStart.
 */

import { spawn } from "node:child_process";
import { createLogger } from "@nexus/core/node";

const log = createLogger("agent:services:git-project");

export interface GitOrigin {
  provider: string;
  ownerRepo: string;
}

/** Execute `git remote get-url origin` and capture stdout. */
async function gitRemoteUrl(cwd: string): Promise<string | null> {
  return new Promise((resolve) => {
    const child = spawn("git", ["remote", "get-url", "origin"], {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const chunks: Buffer[] = [];
    child.stdout.on("data", (b: Buffer) => chunks.push(b));
    child.on("error", () => resolve(null));
    child.on("close", (code) => {
      if (code !== 0) return resolve(null);
      const out = Buffer.concat(chunks).toString("utf8").trim();
      resolve(out.length > 0 ? out : null);
    });
  });
}

/**
 * Parse one of the three supported URL forms into (provider, ownerRepo).
 * Exported for unit tests.
 */
export function parseOriginUrl(url: string): GitOrigin | null {
  if (!url) return null;
  const stripped = url.replace(/\.git$/, "");

  // 1. SSH form: git@host:owner/repo
  const sshMatch = /^git@([^:]+):(.+)$/.exec(stripped);
  if (sshMatch) {
    const provider = sshMatch[1]!;
    const ownerRepo = sshMatch[2]!;
    return validate(provider, ownerRepo);
  }

  // 2 + 3. URL-like forms (https://, http://, git://, ssh://).
  let parsed: URL;
  try {
    parsed = new URL(stripped);
  } catch {
    return null;
  }
  const provider = parsed.hostname;
  // pathname starts with "/"; drop it and anything after the second slash
  const path = parsed.pathname.replace(/^\/+/, "");
  return validate(provider, path);
}

function validate(provider: string, ownerRepoRaw: string): GitOrigin | null {
  if (!provider) return null;
  // Owner/repo must have exactly one slash separator. Reject empties.
  const parts = ownerRepoRaw.split("/").filter((p) => p.length > 0);
  if (parts.length < 2) return null;
  // Coalesce subgroups (gitlab supports owner/group/subgroup/repo) by
  // taking the FIRST two segments as the canonical "owner/repo" so that
  // downstream attribution keys are stable across nested groups. Future
  // enrichment can keep the rest in metadata.
  const ownerRepo = `${parts[0]}/${parts[1]}`;
  return { provider, ownerRepo };
}

/**
 * Public API: resolve the git origin for a cwd.
 * Returns null on any failure — non-git, missing origin, malformed url.
 */
export async function resolveGitOrigin(
  cwd: string | null | undefined,
): Promise<GitOrigin | null> {
  if (!cwd) return null;
  try {
    const url = await gitRemoteUrl(cwd);
    if (!url) return null;
    return parseOriginUrl(url);
  } catch (err) {
    log.warn({ err, cwd }, "git origin resolution failed");
    return null;
  }
}
