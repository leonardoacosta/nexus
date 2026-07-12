import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { nowSecs, statePath, readJsonCache, writeJsonAtomic } from "./cache-io";
import type { CcInput, UsageResponse, CachedUsage } from "./types";

export const FETCH_TIMEOUT_MS = 2_000;
const PROFILE_CACHE_TTL = 3600; // 1 hour (seconds)

// Polled-usage cache: older than this → treat as absent (agent down/undeployed).
// 30 min = poller cadence + backoff headroom; pre-consolidation intent was 300s.
const USAGE_CACHE_MAX_AGE_SECS = 30 * 60;

interface CachedProfile {
  fetched_at: number;
  domain: string;
}

function readAccessToken(): string | null {
  try {
    const path = join(homedir(), ".claude/.credentials.json");
    const content = readFileSync(path, "utf-8");
    const creds = JSON.parse(content);
    const oauth = creds?.claudeAiOauth;
    if (!oauth?.accessToken) return null;
    // Check expiry (expiresAt is in milliseconds)
    if (oauth.expiresAt && Date.now() > oauth.expiresAt) return null;
    return oauth.accessToken as string;
  } catch {
    return null;
  }
}

function usageCachePath(): string {
  return statePath("usage-cache.json");
}

function profileCachePath(): string {
  return statePath("profile-cache.json");
}

async function fetchWithToken<T>(token: string, endpoint: string): Promise<T | null> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    const resp = await fetch(endpoint, {
      signal: controller.signal,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/json",
        "anthropic-beta": "oauth-2025-04-20",
      },
    });
    clearTimeout(timer);
    if (!resp.ok) return null;
    const body = (await resp.json()) as T;
    return body;
  } catch {
    return null;
  }
}

/**
 * Apply the staleness bound to a parsed usage cache. Exported for tests.
 * Missing/non-numeric `fetched_at` → treat as stale (null). The writer
 * (apps/agent statusline-usage-file.ts) always writes unix-seconds
 * `fetched_at`, so a well-formed cache only goes null by aging out.
 */
export function polledUsageFromCache(
  cached: CachedUsage | null | undefined,
  atSecs: number,
): UsageResponse | null {
  if (!cached || typeof cached.fetched_at !== "number") return null;
  if (atSecs - cached.fetched_at > USAGE_CACHE_MAX_AGE_SECS) return null;
  return cached.data ?? null;
}

/**
 * Read the active credential's 5H/7D usage from the shared cache file that
 * nexus-agent's poller writes (statusline-usage-file.ts). Pure file read +
 * parse — NO Anthropic API call, NO credential read. The poller is now the sole
 * caller of `/api/oauth/usage`, which eliminates the uncoordinated dual-caller
 * 429 (proposal §Why). Matches the existing `CachedUsage` shape
 * (`{ fetched_at, data }`) so the writer and reader agree on one schema.
 * Fail-soft: a missing / unreadable / unparseable cache → null (usage segment
 * omitted, never a crash). Caches older than `USAGE_CACHE_MAX_AGE_SECS` are
 * treated as absent — a dead or undeployed poller degrades to an omitted
 * usage segment, never frozen bars. Returns a Promise to satisfy
 * `resolveUsage`'s injectable `fetchApiUsage` signature.
 */
async function getPolledUsage(): Promise<UsageResponse | null> {
  const cached = readJsonCache<CachedUsage>(usageCachePath());
  return polledUsageFromCache(cached, nowSecs());
}

/**
 * Build a `UsageResponse` from the CC stdin `rate_limits` block when BOTH the
 * `five_hour` and `seven_day` windows carry a `used_percentage` (CC v2.1.6+).
 * Maps `used_percentage → utilization`. Reset info is NOT copied onto the
 * `UsagePeriod` here — it flows through the existing `ccInput.rate_limits.*`
 * `resets_at` precedence in `renderStatusline`/`renderUsageGauge` (CC unix-secs
 * wins over any API ISO string). Returns null when either window lacks
 * `used_percentage`, signalling the caller to fall back to the OAuth API.
 */
export function buildStdinUsage(
  rateLimits: CcInput["rate_limits"],
): UsageResponse | null {
  const fh = rateLimits?.five_hour?.used_percentage;
  const sd = rateLimits?.seven_day?.used_percentage;
  if (fh == null || sd == null) return null;
  return {
    five_hour: { utilization: fh },
    seven_day: { utilization: sd },
  };
}

/**
 * Prefer stdin usage over the polled cache. When `buildStdinUsage` yields a
 * value, return it and skip `getPolledUsage()` entirely. Otherwise fall back to
 * the injected fetcher (default `getPolledUsage`, a pure file read of the
 * poller-written cache — no network, no credential access). `fetchApiUsage` is
 * injectable so the fallback gate is testable without a filesystem dependency.
 */
export async function resolveUsage(
  rateLimits: CcInput["rate_limits"],
  fetchApiUsage: () => Promise<UsageResponse | null> = getPolledUsage,
): Promise<UsageResponse | null> {
  const stdin = buildStdinUsage(rateLimits);
  if (stdin != null) return stdin;
  return fetchApiUsage();
}

export async function getAccountDomain(): Promise<string | null> {
  try {
    const cachePath = profileCachePath();
    // Check cache
    const cached = readJsonCache<CachedProfile>(cachePath);
    if (cached && nowSecs() - cached.fetched_at < PROFILE_CACHE_TTL) return cached.domain;

    const token = readAccessToken();
    if (!token) return null;

    const profile = await fetchWithToken<{ account?: { email?: string } }>(
      token,
      "https://api.anthropic.com/api/oauth/profile",
    );
    const email = profile?.account?.email;
    if (!email) return null;

    const domain = email.split("@")[1] ?? email;

    // Write cache — 0o600 per credential-pool spec (profile-cache.json holds email
    // domain; low-sensitivity but spec-gated for consistency with usage-cache).
    const cachedOut: CachedProfile = { fetched_at: nowSecs(), domain };
    writeJsonAtomic(cachePath, cachedOut);

    return domain;
  } catch {
    return null;
  }
}
