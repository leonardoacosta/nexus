import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { nowSecs, statePath, readJsonCache, writeJsonAtomic } from "./cache-io";

export const FETCH_TIMEOUT_MS = 2_000;
const PROFILE_CACHE_TTL = 3600; // 1 hour (seconds)

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
