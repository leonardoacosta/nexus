"use server";

import { fetchWithTimeout } from "@nexus/core/fetch";
import type { Account, CredentialFile, WireCredentialRow } from "@nexus/core";
import { probeAgent, type Reachability } from "@/lib/agent-reachability";
import { getAgentConfigs } from "@/lib/get-client";

// WireCredentialRow is defined in @nexus/core/types/account and re-exported
// from @nexus/core. The local declaration has been removed per task [2.2].

/** Envelope response shape for `GET /credentials`. */
interface CredentialsListResponse {
  credentials: WireCredentialRow[];
  activeFingerprint: string | null;
}

/**
 * Re-exported for callers that still need the per-file row shape. Kept
 * for backward compatibility with code that deals with the flat list.
 * New code should prefer `Account.snapshots` which already has the
 * richer `CredentialFile` shape from `@nexus/core`.
 */
export interface Credential extends WireCredentialRow {
  /** Nested duplicates only appear on primary rows in the agent response. */
  duplicates?: Array<
    Pick<
      WireCredentialRow,
      "id" | "name" | "isPrimary" | "createdAt" | "updatedAt"
    >
  >;
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

/**
 * Legacy group shape retained for the existing CredentialsTable component.
 *
 * The UI phase of this change will migrate to `Account` directly; in the
 * meantime `credGroupMap[id] -> CredentialGroup` preserves the previous
 * API so the page renders unchanged.
 */
export interface CredentialGroup {
  fingerprint: string;
  primary: Credential;
  members: Credential[];
  usage: CredentialUsage | null;
}

// ---------------------------------------------------------------------------
// Return shape
// ---------------------------------------------------------------------------

/**
 * Result of `fetchCredentials()`.
 *
 * Account-first: `accounts` holds one entry per OAuth refresh-token
 * fingerprint. Each account carries the nested snapshot files on disk
 * plus subscription/usage metadata. `credentials` is retained as a
 * flat convenience view (primary-first within each account) for the
 * existing table component during the rollout.
 */
export interface CredentialsResult {
  accounts: Account[];
  credentials: Credential[];
  /**
   * Legacy per-fingerprint grouping. Kept while the UI still consumes
   * `CredentialGroup`. Will be dropped once `accounts` is wired through.
   */
  groups: CredentialGroup[];
  totalAccounts: number;
  totalFiles: number;
  agentSource: string;
  /**
   * Full reachability classification from `probeAgent()`. Components can
   * `switch` on `reachability.reason` to render variant-specific banner copy
   * (e.g. "Build <sha> missing GET /credentials — rebuild needed" for
   * `stale-binary` vs "Agent timed out at <host>:<port>" for `timeout`).
   */
  reachability: Reachability;
  /**
   * Derived from `reachability.ok`. Preserved for backward compatibility with
   * components that only need a yes/no signal — new code SHOULD prefer the
   * `reachability` field above for richer banner copy.
   */
  agentReachable: boolean;
  failedAgents: string[];
  /** Raw fingerprint reported by the agent's active-credential watcher. */
  activeFingerprint: string | null;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const REQUEST_TIMEOUT_MS = 5_000;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Strip the agent's envelope; accept legacy array shape for resilience. */
function parseListResponse(json: unknown): CredentialsListResponse {
  if (Array.isArray(json)) {
    // Legacy agent (pre envelope) — treat whole body as credentials array.
    return {
      credentials: json as WireCredentialRow[],
      activeFingerprint: null,
    };
  }
  const obj = json as Partial<CredentialsListResponse>;
  return {
    credentials: Array.isArray(obj.credentials) ? obj.credentials : [],
    activeFingerprint:
      typeof obj.activeFingerprint === "string" || obj.activeFingerprint === null
        ? obj.activeFingerprint
        : null,
  };
}

/**
 * Collapse an array of rows into per-fingerprint snapshot groups.
 * Sort order within a group: primary first, then by createdAt ascending.
 */
function groupByFingerprint(
  rows: WireCredentialRow[],
): Map<string, WireCredentialRow[]> {
  const groups = new Map<string, WireCredentialRow[]>();
  for (const row of rows) {
    const key = row.duplicateGroupId || row.fingerprint;
    const bucket = groups.get(key);
    if (bucket) {
      bucket.push(row);
    } else {
      groups.set(key, [row]);
    }
  }
  for (const [key, bucket] of groups) {
    bucket.sort((a, b) => {
      if (a.isPrimary && !b.isPrimary) return -1;
      if (!a.isPrimary && b.isPrimary) return 1;
      return new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime();
    });
    groups.set(key, bucket);
  }
  return groups;
}

function toCredentialFile(row: WireCredentialRow): CredentialFile {
  return {
    id: row.id,
    name: row.name,
    status: row.status,
    type: row.type,
    fingerprint: row.fingerprint,
    duplicateGroupId: row.duplicateGroupId ?? row.fingerprint,
    isPrimary: row.isPrimary,
    expiresAt: row.expiresAt,
    rateLimitCount: row.rateLimitCount,
    leasedBy: row.leasedBy,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

// ---------------------------------------------------------------------------
// Server action
// ---------------------------------------------------------------------------

/**
 * Fetch credentials from the first reachable agent, group by fingerprint,
 * attach the active-account indicator, and fetch per-account usage for
 * every visible account (with per-account error isolation so a single
 * Anthropic API hiccup does not tank the whole page).
 *
 * Order: probe `/version` first (the version handshake — see
 * `apps/nextjs/src/lib/agent-reachability.ts`). When the probe fails for any
 * reason — no agent registered, timeout, http-error, or stale-binary missing
 * `GET /credentials` — skip the per-agent `/credentials` loop entirely. The
 * `Reachability` value is returned so the page can render banner copy
 * specific to the failure mode (build sha + missing capabilities for stale,
 * host:port for timeout, etc.) instead of collapsing to "agent unreachable".
 */
export async function fetchCredentials(): Promise<CredentialsResult> {
  const reachability = await probeAgent();
  const configs = await getAgentConfigs();

  // Probe failed: short-circuit. The page-data return shape mirrors the
  // existing empty-state below so the UI consumer renders unchanged.
  if (!reachability.ok) {
    const agentSource =
      reachability.reason === "no-agent" ? "unknown" : reachability.agent.name;
    return {
      accounts: [],
      credentials: [],
      groups: [],
      totalAccounts: 0,
      totalFiles: 0,
      agentSource,
      reachability,
      agentReachable: false,
      failedAgents: [],
      activeFingerprint: null,
    };
  }

  let allRows: WireCredentialRow[] = [];
  let activeFingerprint: string | null = null;
  let agentSource = reachability.agent.name;
  const failedAgents: string[] = [];

  // Try each agent until one responds. The version probe above already
  // confirmed the first registered agent is reachable and has the
  // `GET /credentials` capability, but the existing multi-agent loop is
  // preserved so a transient `/credentials` failure on the primary still
  // falls back to the next agent.
  for (const agent of configs) {
    try {
      const res = await fetchWithTimeout(
        `http://${agent.host}:${agent.port}/credentials`,
        {
          timeout: REQUEST_TIMEOUT_MS,
          cache: "no-store",
        },
      );
      if (!res.ok) {
        failedAgents.push(`${agent.name} (${agent.host}:${agent.port})`);
        continue;
      }
      const parsed = parseListResponse(await res.json());
      allRows = parsed.credentials;
      activeFingerprint = parsed.activeFingerprint;
      agentSource = agent.name;
      break;
    } catch {
      failedAgents.push(`${agent.name} (${agent.host}:${agent.port})`);
    }
  }

  if (allRows.length === 0) {
    return {
      accounts: [],
      credentials: [],
      groups: [],
      totalAccounts: 0,
      totalFiles: 0,
      agentSource,
      reachability,
      agentReachable: reachability.ok,
      failedAgents,
      activeFingerprint,
    };
  }

  // Build per-fingerprint buckets (snapshots).
  const buckets = groupByFingerprint(allRows);

  // Initial accounts — usage fields null, will be filled in below.
  const accounts: Account[] = [];
  for (const bucket of buckets.values()) {
    const primary = bucket.find((r) => r.isPrimary) ?? bucket[0]!;
    accounts.push({
      fingerprint: primary.fingerprint,
      isActiveForCc:
        activeFingerprint !== null && primary.fingerprint === activeFingerprint,
      usagePercent: null,
      resetsAt: null,
      plan: primary.subscriptionType,
      tier: primary.rateLimitTier,
      snapshots: bucket.map(toCredentialFile),
    });
  }

  // Fetch usage for every visible account (not just the first 10) with
  // per-account error isolation — one failing Anthropic request must not
  // zero out the rest of the table. Results are accumulated into
  // `perAccountUsage` keyed by primary credential id so both the new
  // `accounts[]` and legacy `groups[]` shapes can consume them.
  const perAccountUsage = new Map<string, CredentialUsage>();
  const agentConfig =
    configs.find((a) => a.name === agentSource) ?? configs[0];
  if (agentConfig) {
    const baseUrl = `http://${agentConfig.host}:${agentConfig.port}`;
    await Promise.all(
      accounts.map(async (account) => {
        const primary = account.snapshots[0];
        if (!primary) return;
        try {
          const res = await fetchWithTimeout(
            `${baseUrl}/credentials/${encodeURIComponent(primary.id)}/usage?window=24h`,
            {
              timeout: REQUEST_TIMEOUT_MS,
              cache: "no-store",
            },
          );
          if (!res.ok) return;
          const usage = (await res.json()) as CredentialUsage | null;
          if (!usage || typeof usage !== "object") return;
          perAccountUsage.set(primary.id, usage);
        } catch {
          // Swallow per-account failures — other accounts still render.
        }
      }),
    );
  }

  // Flat view preserved for the legacy table: primary-first per account,
  // then concatenated in account order.
  const flatCredentials: Credential[] = accounts.flatMap((account) =>
    account.snapshots.map((snap) => {
      const row = allRows.find((r) => r.id === snap.id)!;
      return { ...row };
    }),
  );

  // Legacy `groups` derived from accounts so existing UI keeps working.
  const groups: CredentialGroup[] = accounts.map((account) => {
    const members: Credential[] = account.snapshots.map((snap) => {
      const row = allRows.find((r) => r.id === snap.id)!;
      return { ...row };
    });
    const primary = members.find((m) => m.isPrimary) ?? members[0]!;
    return {
      fingerprint: account.fingerprint,
      primary,
      members,
      usage: perAccountUsage.get(primary.id) ?? null,
    };
  });

  return {
    accounts,
    credentials: flatCredentials,
    groups,
    totalAccounts: accounts.length,
    totalFiles: allRows.length,
    agentSource,
    reachability,
    agentReachable: reachability.ok,
    failedAgents,
    activeFingerprint,
  };
}
