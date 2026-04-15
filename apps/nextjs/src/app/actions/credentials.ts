"use server";

import { fetchWithTimeout } from "@nexus/core/fetch";
import { getAgentConfigs } from "@/lib/get-client";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface CredentialDuplicate {
  id: string;
  name: string;
  isPrimary: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface Credential {
  id: string;
  name: string;
  status: string;
  type: string;
  fingerprint: string;
  duplicateGroupId: string;
  isPrimary: boolean;
  subscriptionType: string | null;
  rateLimitTier: string | null;
  expiresAt: string | null;
  rateLimitCount: number;
  leasedBy: string | null;
  createdAt: string;
  updatedAt: string;
  duplicates?: CredentialDuplicate[];
}

export interface CredentialUsage {
  input: number;
  output: number;
  cache_creation: number;
  cache_read: number;
  cost_usd: number | null;
  turn_count: number;
  session_count: number;
}

export interface CredentialGroup {
  fingerprint: string;
  primary: Credential;
  members: Credential[];
  usage: CredentialUsage | null;
}

export interface CredentialsResult {
  groups: CredentialGroup[];
  credentials: Credential[];
  totalAccounts: number;
  totalFiles: number;
  agentSource: string;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const REQUEST_TIMEOUT_MS = 5_000;

// ---------------------------------------------------------------------------
// Server action
// ---------------------------------------------------------------------------

/**
 * Fetch credentials from the first reachable agent, group by fingerprint,
 * and fetch 24h usage for each primary credential.
 */
export async function fetchCredentials(): Promise<CredentialsResult> {
  const configs = await getAgentConfigs();
  const secret = process.env.NEXUS_ATTACH_SECRET ?? "";

  let allCredentials: Credential[] = [];
  let agentSource = "unknown";

  // Try each agent until one responds
  for (const agent of configs) {
    try {
      const res = await fetchWithTimeout(
        `http://${agent.host}:${agent.port}/credentials`,
        {
          timeout: REQUEST_TIMEOUT_MS,
          headers: { "x-nexus-secret": secret },
          cache: "no-store",
        },
      );
      if (!res.ok) continue;
      allCredentials = (await res.json()) as Credential[];
      agentSource = agent.name;
      break;
    } catch {
      // Agent unreachable, try next
    }
  }

  if (allCredentials.length === 0) {
    return {
      groups: [],
      credentials: [],
      totalAccounts: 0,
      totalFiles: 0,
      agentSource,
    };
  }

  // Group by duplicateGroupId (same as fingerprint)
  const groupMap = new Map<string, Credential[]>();
  for (const cred of allCredentials) {
    const key = cred.duplicateGroupId || cred.fingerprint;
    const group = groupMap.get(key);
    if (group) {
      group.push(cred);
    } else {
      groupMap.set(key, [cred]);
    }
  }

  // Build groups with primary first
  const groups: CredentialGroup[] = [];
  for (const [fingerprint, members] of groupMap) {
    // Sort: primary first, then by createdAt ascending
    const sorted = [...members].sort((a, b) => {
      if (a.isPrimary && !b.isPrimary) return -1;
      if (!a.isPrimary && b.isPrimary) return 1;
      return new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime();
    });

    const primary = sorted.find((m) => m.isPrimary) ?? sorted[0]!;

    groups.push({
      fingerprint,
      primary,
      members: sorted,
      usage: null,
    });
  }

  // Fetch usage for up to 10 primary credentials in parallel (best-effort)
  const agentConfig = configs.find((a) => a.name === agentSource) ?? configs[0];
  if (agentConfig) {
    const usageSlice = groups.slice(0, 10);
    const usageResults = await Promise.allSettled(
      usageSlice.map(async (group) => {
        const res = await fetchWithTimeout(
          `http://${agentConfig.host}:${agentConfig.port}/credentials/${encodeURIComponent(group.primary.id)}/usage?window=24h`,
          {
            timeout: REQUEST_TIMEOUT_MS,
            headers: { "x-nexus-secret": secret },
            cache: "no-store",
          },
        );
        if (!res.ok) return null;
        return (await res.json()) as CredentialUsage;
      }),
    );

    for (let i = 0; i < usageResults.length; i++) {
      const result = usageResults[i]!;
      if (result.status === "fulfilled" && result.value) {
        groups[i]!.usage = result.value;
      }
    }
  }

  return {
    groups,
    credentials: allCredentials,
    totalAccounts: groups.length,
    totalFiles: allCredentials.length,
    agentSource,
  };
}
