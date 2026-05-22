/**
 * git-project — resolve git origin metadata for a working directory.
 *
 * Spec: openspec/changes/add-git-project-resolver
 *       openspec/changes/projects-tab-accordion-deeplink (task 1.1, 1.2)
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
 *
 * `getGitMetadata` extends the service with branch/ahead/behind/dirty +
 * last-commit metadata for the Projects tab accordion. Uses
 * `git status --porcelain=v2 --branch` for deterministic parsing across
 * git ≥2.11. A per-cwd cache with 30s TTL absorbs the cost of repeated
 * `GET /projects` polls; negative results (timeout, broken repo) are
 * cached too so a flapping repo doesn't peg CPU.
 */

import { createLogger } from "@nexus/core/node";

const log = createLogger("agent:services:git-project");

export interface GitOrigin {
  provider: string;
  ownerRepo: string;
}

/**
 * Execute `git remote get-url origin` and capture stdout.
 *
 * Uses `Bun.spawn` with an arg-vector (cwd passed via `-C`) — mirrors the
 * canonical pattern in `git-project-resolver.ts#execGitRemoteUrl`. Returns
 * `null` on any spawn error, non-zero exit, or empty output.
 */
async function gitRemoteUrl(cwd: string): Promise<string | null> {
  try {
    const proc = Bun.spawn(["git", "-C", cwd, "remote", "get-url", "origin"], {
      stdout: "pipe",
      stderr: "pipe",
      stdin: "ignore",
    });
    const [stdout, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      proc.exited,
    ]);
    if (exitCode !== 0) return null;
    const out = stdout.trim();
    return out.length > 0 ? out : null;
  } catch {
    return null;
  }
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

// ── Git metadata (branch/ahead/behind/dirty/last-commit) ───────────────────

export interface GitCommit {
  author: string;
  /** ISO-8601 timestamp string. Mirrored as `Date` in the Swift decoder. */
  ts: string;
}

export interface GitMetadata {
  /** Branch name, or `null` for detached HEAD. */
  branch: string | null;
  ahead: number;
  behind: number;
  dirty: boolean;
  last_commit: GitCommit | null;
}

interface CacheEntry {
  value: GitMetadata | null;
  expiresAt: number;
}

const GIT_METADATA_TTL_MS = 30_000;
const GIT_METADATA_TIMEOUT_MS = 2_000;
const gitMetadataCache = new Map<string, CacheEntry>();

/** Clear cached metadata. Tests call this to isolate scenarios. */
export function clearGitMetadataCache(): void {
  gitMetadataCache.clear();
}

/**
 * Spawn `git status --porcelain=v2 --branch && git log -1` in a single
 * shell. Returns combined stdout, or null on timeout / non-zero exit /
 * missing git / cwd not a repo. AbortController kills the subprocess
 * tree if it exceeds the 2s budget.
 *
 * Uses `Bun.spawn` (mirrors `git-project-resolver.ts` pattern). The cwd
 * is interpolated into the shell `$0` positional so we never embed
 * user-controlled paths into shell strings.
 */
async function spawnGitMetadata(cwd: string): Promise<string | null> {
  // `--untracked-files=no` skips the (often huge) untracked-file
  // enumeration — for dirty detection any tracked modification is enough.
  const cmd = [
    "git -C \"$0\" status --porcelain=v2 --branch --untracked-files=no",
    "git -C \"$0\" log -1 --format=%aN%n%aI",
  ].join(" && ");

  let timer: ReturnType<typeof setTimeout> | null = null;
  try {
    const proc = Bun.spawn(["/bin/sh", "-c", cmd, cwd], {
      stdout: "pipe",
      stderr: "pipe",
      stdin: "ignore",
    });
    timer = setTimeout(() => {
      try {
        proc.kill();
      } catch {
        /* already exited */
      }
    }, GIT_METADATA_TIMEOUT_MS);
    const [stdout, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      proc.exited,
    ]);
    if (exitCode !== 0) return null;
    return stdout;
  } catch {
    return null;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Parse `git status --porcelain=v2 --branch` + `git log -1 --format=%aN%n%aI`
 * combined output. Exported for unit tests.
 *
 * Format:
 *   # branch.head <name>         (or `(detached)`)
 *   # branch.ab +X -Y            (may be absent if no upstream)
 *   <entry-line>...              (1 / 2 / u / ? prefixed — presence ⇒ dirty)
 *   <author>
 *   <iso-timestamp>
 */
export function parseGitMetadata(raw: string): GitMetadata | null {
  if (!raw) return null;
  const lines = raw.split(/\r?\n/);
  let branch: string | null = null;
  let ahead = 0;
  let behind = 0;
  let dirty = false;
  let sawBranchHead = false;

  // Last non-empty lines (after the status block) are author + ISO ts.
  // Iterate forward to extract status, then peek the tail for commit.
  const tail: string[] = [];

  for (const rawLine of lines) {
    const line = rawLine;
    if (line.startsWith("# branch.head ")) {
      const name = line.slice("# branch.head ".length).trim();
      branch = name === "(detached)" ? null : name;
      sawBranchHead = true;
      continue;
    }
    if (line.startsWith("# branch.ab ")) {
      const rest = line.slice("# branch.ab ".length).trim();
      const m = /^\+(-?\d+)\s+-(-?\d+)$/.exec(rest);
      if (m) {
        ahead = parseInt(m[1]!, 10);
        behind = parseInt(m[2]!, 10);
      }
      continue;
    }
    if (line.startsWith("#")) continue;
    // Entry lines from --porcelain=v2: `1 ` (changed), `2 ` (renamed/copied),
    // `u ` (unmerged), `? ` (untracked — suppressed by --untracked-files=no).
    if (
      line.startsWith("1 ") ||
      line.startsWith("2 ") ||
      line.startsWith("u ") ||
      line.startsWith("? ")
    ) {
      dirty = true;
      continue;
    }
    // Non-empty, non-status line — candidate for the log tail.
    if (line.trim().length > 0) tail.push(line);
  }

  if (!sawBranchHead) return null;

  let last_commit: GitCommit | null = null;
  if (tail.length >= 2) {
    const ts = tail[tail.length - 1]!.trim();
    const author = tail[tail.length - 2]!.trim();
    // ISO-8601 sanity: `git log %aI` always emits a valid ISO timestamp,
    // but if upstream output ever drifts we'd rather emit `null` than a
    // garbage string the Swift Date decoder will reject.
    if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.test(ts) && author.length > 0) {
      last_commit = { author, ts };
    }
  }

  return { branch, ahead, behind, dirty, last_commit };
}

/**
 * Public API: resolve git metadata for a cwd with 30s caching.
 *
 * Cache HIT returns immediately (no subprocess). Cache MISS spawns the
 * status + log pair with a 2s timeout; negative results (null) are cached
 * too so a misconfigured repo doesn't burn CPU on every poll.
 *
 * Returns `null` for non-git directories, subprocess failures, or timeouts.
 */
export async function getGitMetadata(
  cwd: string | null | undefined,
): Promise<GitMetadata | null> {
  if (!cwd) return null;
  const now = Date.now();
  const cached = gitMetadataCache.get(cwd);
  if (cached && cached.expiresAt > now) {
    return cached.value;
  }
  let value: GitMetadata | null = null;
  try {
    const raw = await spawnGitMetadata(cwd);
    if (raw !== null) {
      value = parseGitMetadata(raw);
    }
  } catch (err) {
    log.warn({ err, cwd }, "git metadata resolution failed");
    value = null;
  }
  if (value === null) {
    log.warn({ cwd }, "git metadata returned null — caching negative result");
  }
  gitMetadataCache.set(cwd, {
    value,
    expiresAt: now + GIT_METADATA_TTL_MS,
  });
  return value;
}
