/**
 * git-project-resolver — full project enrichment for a working directory.
 *
 * Spec: openspec/changes/session-row-enrichment-v1 § Agent (tasks 1.2, 1.3, 1.4, 1.5)
 * Supersedes the narrower git-project.ts (which only returns provider/ownerRepo).
 *
 * Given a cwd, this resolver:
 *   1. Spawns `git -C <cwd> remote get-url origin` via `Bun.spawn` (arg-vector,
 *      no shell — injection-safe).
 *   2. Parses the origin URL into `{provider, ownerRepo}` for 4 providers:
 *      github.com, dev.azure.com (+ *.visualstudio.com), gitlab.com,
 *      bitbucket.org. Both HTTPS and SSH forms are accepted. Trailing `.git`
 *      is stripped from ownerRepo.
 *   3. Cross-references the `projects` table by `git_remote_url` to derive
 *      the canonical `projectId`. If no registry match, `projectId = null`
 *      but provider/ownerRepo still emit.
 *
 * Caching: results are memoised by cwd for 30 seconds. The process-watcher's
 * 30s poll cadence MUST NOT re-shell `git remote` on every tick.
 *
 * Fail-soft: every failure mode (non-git, missing origin, git binary missing,
 * malformed URL, DB lookup error) returns `null`. The resolver NEVER throws.
 * Callers MUST treat a `null` return as "no enrichment available, proceed
 * with null fields on the session row".
 */

import type { Db } from "@nexus/db";
import { projects } from "@nexus/db";
import { eq } from "drizzle-orm";
import { createLogger } from "@nexus/core/node";

const log = createLogger("agent:services:git-project-resolver");

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface GitProjectInfo {
  /**
   * Provider short-name. One of:
   *   - "github"        (github.com)
   *   - "azure-devops"  (dev.azure.com, *.visualstudio.com)
   *   - "gitlab"        (gitlab.com)
   *   - "bitbucket"     (bitbucket.org)
   *   - "<hostname>"    (any other host — passed through unchanged)
   */
  provider: string;
  /** Canonical "owner/repo" string. Trailing `.git` stripped. */
  ownerRepo: string;
  /** Project id from the `projects` registry, or null when no match. */
  projectId: string | null;
}

// ---------------------------------------------------------------------------
// URL parsing — task 1.3
// ---------------------------------------------------------------------------

interface ProviderHit {
  provider: string;
  ownerRepo: string;
}

/**
 * Normalise a provider hostname into the short-name used by the wire shape.
 *
 * Unknown hosts pass through unchanged — downstream consumers can group by
 * the full hostname and we keep the resolver tolerant of self-hosted forges.
 */
function shortProvider(hostname: string): string {
  const h = hostname.toLowerCase();
  if (h === "github.com" || h.endsWith(".github.com")) return "github";
  if (h === "dev.azure.com" || h.endsWith(".visualstudio.com")) return "azure-devops";
  if (h === "gitlab.com" || h.endsWith(".gitlab.com")) return "gitlab";
  if (h === "bitbucket.org" || h.endsWith(".bitbucket.org")) return "bitbucket";
  return h;
}

/**
 * Azure DevOps URL form: `https://dev.azure.com/{org}/{project}/_git/{repo}`.
 * The middle `{project}` segment is internal Azure org structure — our
 * canonical ownerRepo is `{org}/{repo}`.
 *
 * Visual Studio variant: `https://{org}.visualstudio.com/{project}/_git/{repo}`
 * — same shape, org embedded in the hostname instead. Returns `null` when
 * the path doesn't match either Azure shape.
 */
function parseAzureDevOpsPath(hostname: string, rawPath: string): ProviderHit | null {
  const path = rawPath.replace(/^\/+/, "");
  const segments = path.split("/").filter((s) => s.length > 0);
  const gitIdx = segments.indexOf("_git");
  if (gitIdx < 0) return null;
  const repo = segments[gitIdx + 1];
  if (!repo) return null;

  // Form A: dev.azure.com/{org}/{project}/_git/{repo}
  if (hostname.toLowerCase() === "dev.azure.com") {
    const org = segments[0];
    if (!org || gitIdx < 2) return null;
    return { provider: "azure-devops", ownerRepo: `${org}/${repo}` };
  }

  // Form B: {org}.visualstudio.com/{project}/_git/{repo}
  if (hostname.toLowerCase().endsWith(".visualstudio.com")) {
    const org = hostname.split(".")[0];
    if (!org) return null;
    return { provider: "azure-devops", ownerRepo: `${org}/${repo}` };
  }

  return null;
}

/**
 * Parse a raw `git remote get-url origin` value into provider + owner/repo.
 *
 * Supported forms:
 *   1. SSH:    git@github.com:owner/repo.git
 *   2. HTTPS:  https://github.com/owner/repo.git
 *   3. git://: git://github.com/owner/repo
 *   4. SSH-url: ssh://git@github.com/owner/repo.git
 *   5. Azure:  https://dev.azure.com/org/project/_git/repo
 *   6. VSO:    https://org.visualstudio.com/project/_git/repo
 *
 * Returns `null` for empty / unparseable / single-segment paths.
 *
 * Exported for unit tests.
 */
export function parseOriginUrl(url: string): ProviderHit | null {
  if (!url) return null;
  const trimmed = url.trim();
  if (!trimmed) return null;

  // 1. SSH form: git@host:owner/repo[.git]
  const sshMatch = /^git@([^:]+):(.+)$/.exec(trimmed);
  if (sshMatch) {
    const hostname = sshMatch[1]!;
    const pathRaw = sshMatch[2]!.replace(/\.git$/, "");
    const parts = pathRaw.split("/").filter((p) => p.length > 0);
    if (parts.length < 2) return null;
    return {
      provider: shortProvider(hostname),
      ownerRepo: `${parts[0]}/${parts[1]}`,
    };
  }

  // 2-6. URL-like forms (https://, http://, git://, ssh://).
  const stripped = trimmed.replace(/\.git$/, "");
  let parsed: URL;
  try {
    parsed = new URL(stripped);
  } catch {
    return null;
  }
  const hostname = parsed.hostname;
  if (!hostname) return null;

  // Azure DevOps + Visual Studio Online — special path shape.
  const azure = parseAzureDevOpsPath(hostname, parsed.pathname);
  if (azure) return azure;

  // Generic owner/repo path. Coalesce subgroups (gitlab supports nested
  // groups) to the first two non-empty segments.
  const path = parsed.pathname.replace(/^\/+/, "");
  const parts = path.split("/").filter((p) => p.length > 0);
  if (parts.length < 2) return null;
  return {
    provider: shortProvider(hostname),
    ownerRepo: `${parts[0]}/${parts[1]}`,
  };
}

// ---------------------------------------------------------------------------
// git remote subprocess — task 1.2
// ---------------------------------------------------------------------------

/**
 * Run `git -C <cwd> remote get-url origin` and return the captured stdout
 * (trimmed). Returns `null` on non-zero exit, empty output, or spawn error.
 *
 * Uses `Bun.spawn` with an arg-vector (no shell) — cwd is passed as an
 * argument to `git -C`, never interpolated into a shell string.
 *
 * Exported for unit tests that want to override the subprocess.
 */
export async function execGitRemoteUrl(cwd: string): Promise<string | null> {
  try {
    const proc = Bun.spawn(["git", "-C", cwd, "remote", "get-url", "origin"], {
      stdout: "pipe",
      stderr: "pipe",
      // Ignore stdin — git remote does not read it.
      stdin: "ignore",
    });
    const [stdout, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      proc.exited,
    ]);
    if (exitCode !== 0) return null;
    const out = stdout.trim();
    return out.length > 0 ? out : null;
  } catch (err) {
    log.debug(
      { err: err instanceof Error ? err.message : String(err), cwd },
      "git remote get-url spawn failed",
    );
    return null;
  }
}

// ---------------------------------------------------------------------------
// Project-registry lookup — task 1.3 (projectId resolution)
// ---------------------------------------------------------------------------

/**
 * Look up the canonical projectId for a parsed origin. Matches against
 * `projects.git_remote_url` — the resolver tries multiple normalised forms
 * because the registry may have stored the URL as HTTPS or SSH and we want
 * to match regardless of the form on disk.
 *
 * Returns `null` when the DB is unavailable, the projects table is empty,
 * or no row matches. Never throws.
 */
async function lookupProjectId(
  db: Db | null | undefined,
  hit: ProviderHit,
  rawUrl: string,
): Promise<string | null> {
  if (!db) return null;
  try {
    // Try the raw URL first (most likely match for self-discovered projects).
    // Then try canonical HTTPS + SSH forms — covers the case where the
    // registry stored the opposite form to what `git remote get-url` returned.
    const candidates = new Set<string>([rawUrl, rawUrl.replace(/\.git$/, "")]);
    // Generic provider-specific canonical forms.
    if (hit.provider === "github") {
      candidates.add(`https://github.com/${hit.ownerRepo}.git`);
      candidates.add(`https://github.com/${hit.ownerRepo}`);
      candidates.add(`git@github.com:${hit.ownerRepo}.git`);
      candidates.add(`git@github.com:${hit.ownerRepo}`);
    } else if (hit.provider === "gitlab") {
      candidates.add(`https://gitlab.com/${hit.ownerRepo}.git`);
      candidates.add(`https://gitlab.com/${hit.ownerRepo}`);
      candidates.add(`git@gitlab.com:${hit.ownerRepo}.git`);
      candidates.add(`git@gitlab.com:${hit.ownerRepo}`);
    } else if (hit.provider === "bitbucket") {
      candidates.add(`https://bitbucket.org/${hit.ownerRepo}.git`);
      candidates.add(`https://bitbucket.org/${hit.ownerRepo}`);
      candidates.add(`git@bitbucket.org:${hit.ownerRepo}.git`);
      candidates.add(`git@bitbucket.org:${hit.ownerRepo}`);
    }
    for (const candidate of candidates) {
      const rows = await db
        .select({ id: projects.id })
        .from(projects)
        .where(eq(projects.gitRemoteUrl, candidate))
        .limit(1);
      if (rows.length > 0 && rows[0]) return rows[0].id;
    }
    return null;
  } catch (err) {
    log.debug(
      { err: err instanceof Error ? err.message : String(err), ownerRepo: hit.ownerRepo },
      "projectId lookup failed",
    );
    return null;
  }
}

// ---------------------------------------------------------------------------
// 30-second in-memory cache — task 1.2
// ---------------------------------------------------------------------------

interface CacheEntry {
  result: GitProjectInfo | null;
  expiresAt: number;
}

const CACHE_TTL_MS = 30_000;

/**
 * Per-cwd cache. The process-watcher polls every 30s; without the cache
 * every tick would re-spawn `git remote get-url` for every live session.
 *
 * Keyed by raw cwd (no normalisation). Two different cwds for the same repo
 * will resolve independently — that's fine; the second call still hits the
 * same projectId via the registry lookup.
 */
const cache = new Map<string, CacheEntry>();

/**
 * Reset the cache. Test-only — production code should never call this.
 */
export function __resetCacheForTests(): void {
  cache.clear();
  cacheStats.hits = 0;
  cacheStats.misses = 0;
}

// ---------------------------------------------------------------------------
// Cache hit/miss counters — process-watcher-health-monitoring
// ---------------------------------------------------------------------------
//
// Process-level counters (monotonic from process start). Read by the
// `/health/process-watcher` probe + the future `/metrics` surface. Reset by
// `__resetCacheForTests` so test isolation stays predictable.

const cacheStats = { hits: 0, misses: 0 };

/** Snapshot the resolver's cache stats. */
export function resolverCacheStats(): { hits: number; misses: number; total: number; ratio: number } {
  const hits = cacheStats.hits;
  const misses = cacheStats.misses;
  const total = hits + misses;
  const ratio = total === 0 ? 0 : hits / total;
  return { hits, misses, total, ratio };
}

// ---------------------------------------------------------------------------
// Public API — task 1.2 + 1.4 + 1.5 wire-in surface
// ---------------------------------------------------------------------------

/**
 * Resolve a working directory to its git project metadata.
 *
 * Pipeline:
 *   1. Cache hit?  → return cached entry (no subprocess, no DB call).
 *   2. Spawn `git -C <cwd> remote get-url origin`. Non-zero or empty → null.
 *   3. Parse the URL into provider + ownerRepo. Unparseable → null.
 *   4. Cross-reference `projects.git_remote_url` → projectId (or null).
 *   5. Store in cache with `expiresAt = now + 30_000` and return.
 *
 * Failure modes (return null):
 *   - cwd is null / empty
 *   - cwd is not a git repo
 *   - origin remote is unset
 *   - URL is malformed / unparseable
 *   - git binary missing
 *
 * Never throws. Errors are logged at debug level.
 */
export async function resolveProject(
  cwd: string | null | undefined,
  db: Db | null | undefined,
): Promise<GitProjectInfo | null> {
  if (!cwd) return null;

  // 1. Cache hit?
  const now = Date.now();
  const cached = cache.get(cwd);
  if (cached && cached.expiresAt > now) {
    cacheStats.hits += 1;
    return cached.result;
  }
  cacheStats.misses += 1;

  // 2. git remote get-url origin
  const rawUrl = await execGitRemoteUrl(cwd);
  if (!rawUrl) {
    cache.set(cwd, { result: null, expiresAt: now + CACHE_TTL_MS });
    return null;
  }

  // 3. URL parse
  const hit = parseOriginUrl(rawUrl);
  if (!hit) {
    cache.set(cwd, { result: null, expiresAt: now + CACHE_TTL_MS });
    return null;
  }

  // 4. projectId lookup (best-effort; null is fine).
  const projectId = await lookupProjectId(db, hit, rawUrl);

  const result: GitProjectInfo = {
    provider: hit.provider,
    ownerRepo: hit.ownerRepo,
    projectId,
  };
  cache.set(cwd, { result, expiresAt: now + CACHE_TTL_MS });
  return result;
}
