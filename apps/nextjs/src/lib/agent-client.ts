import type {
  AgentConfig,
  NexusConfig,
  Session,
  HealthMetrics,
  Project,
} from "@nexus/core";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Any item tagged with the agent it came from. */
export type WithAgent<T> = T & { agent: string };

/** Per-agent online/offline status. */
export interface AgentStatus {
  name: string;
  online: boolean;
  lastSeen: Date | null;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const REQUEST_TIMEOUT_MS = 3_000;
const RETRY_DELAY_MS = 1_000;
const MAX_RETRIES = 1;

const CACHE_TTL_SHORT_MS = 1_000; // sessions, health
const CACHE_TTL_LONG_MS = 5_000; // projects

// ---------------------------------------------------------------------------
// Cache
// ---------------------------------------------------------------------------

interface CacheEntry<T> {
  value: T;
  expiresAt: number;
}

class TtlCache {
  private store = new Map<string, CacheEntry<unknown>>();

  async get<T>(key: string, ttlMs: number, fetcher: () => Promise<T>): Promise<T> {
    const now = Date.now();
    const existing = this.store.get(key) as CacheEntry<T> | undefined;
    if (existing && existing.expiresAt > now) {
      return existing.value;
    }
    const value = await fetcher();
    this.store.set(key, { value, expiresAt: now + ttlMs });
    return value;
  }

  clear(): void {
    this.store.clear();
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function agentBaseUrl(agent: AgentConfig): string {
  return `http://${agent.host}:${agent.port}`;
}

async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Fetch with a timeout and up to MAX_RETRIES retries.
 * Uses AbortController for the 3-second timeout per attempt.
 */
async function fetchWithRetry(url: string): Promise<Response> {
  let lastError: unknown;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    if (attempt > 0) {
      await sleep(RETRY_DELAY_MS);
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

    try {
      const res = await fetch(url, { signal: controller.signal });
      clearTimeout(timer);
      if (!res.ok) {
        throw new Error(`HTTP ${res.status}: ${res.statusText}`);
      }
      return res;
    } catch (err) {
      clearTimeout(timer);
      lastError = err;
    }
  }

  throw lastError;
}

// ---------------------------------------------------------------------------
// AgentClient
// ---------------------------------------------------------------------------

export class AgentClient {
  private agents: AgentConfig[];
  private lastSeen = new Map<string, Date>();
  private cache = new TtlCache();

  constructor(agents: AgentConfig[]) {
    this.agents = agents;
  }

  // ---- Parallel multi-agent fetches ----------------------------------------

  async fetchAllSessions(): Promise<WithAgent<Session>[]> {
    return this.cache.get("all-sessions", CACHE_TTL_SHORT_MS, async () => {
      const results = await this.fetchFromAll<Session[]>("/sessions");
      return this.mergeResults(results);
    });
  }

  async fetchAllHealth(): Promise<WithAgent<HealthMetrics>[]> {
    return this.cache.get("all-health", CACHE_TTL_SHORT_MS, async () => {
      const results = await this.fetchFromAll<HealthMetrics>("/health");
      return this.mergeResults(results);
    });
  }

  async fetchAllProjects(): Promise<WithAgent<Project>[]> {
    return this.cache.get("all-projects", CACHE_TTL_LONG_MS, async () => {
      const results = await this.fetchFromAll<Project[]>("/projects");
      return this.mergeResults(results);
    });
  }

  // ---- Single-agent fetches ------------------------------------------------

  async fetchSession(agentName: string, sessionId: string): Promise<WithAgent<Session> | null> {
    const agent = this.findAgent(agentName);
    if (!agent) return null;

    try {
      const res = await fetchWithRetry(
        `${agentBaseUrl(agent)}/sessions/${encodeURIComponent(sessionId)}`,
      );
      const data = (await res.json()) as Session;
      this.markOnline(agentName);
      return { ...data, agent: agentName };
    } catch {
      this.markOffline(agentName);
      return null;
    }
  }

  async fetchHealthHistory(
    agentName: string,
    hours: number = 1,
  ): Promise<WithAgent<HealthMetrics>[] | null> {
    const agent = this.findAgent(agentName);
    if (!agent) return null;

    try {
      const res = await fetchWithRetry(
        `${agentBaseUrl(agent)}/health/history?hours=${hours}`,
      );
      const data = (await res.json()) as HealthMetrics[];
      this.markOnline(agentName);
      return data.map((d) => ({ ...d, agent: agentName }));
    } catch {
      this.markOffline(agentName);
      return null;
    }
  }

  // ---- Status --------------------------------------------------------------

  getAgentStatuses(): AgentStatus[] {
    return this.agents.map((a) => ({
      name: a.name,
      online: this.isOnline(a.name),
      lastSeen: this.lastSeen.get(a.name) ?? null,
    }));
  }

  // ---- Internals -----------------------------------------------------------

  /**
   * Fire parallel requests to all agents for a given path.
   * Returns settled results keyed by agent name.
   */
  private async fetchFromAll<T>(
    path: string,
  ): Promise<Map<string, T>> {
    const settled = await Promise.allSettled(
      this.agents.map(async (agent) => {
        const res = await fetchWithRetry(`${agentBaseUrl(agent)}${path}`);
        const data = (await res.json()) as T;
        this.markOnline(agent.name);
        return { name: agent.name, data };
      }),
    );

    const results = new Map<string, T>();
    for (let i = 0; i < settled.length; i++) {
      const result = settled[i]!;
      const agentName = this.agents[i]!.name;
      if (result.status === "fulfilled") {
        results.set(result.value.name, result.value.data);
      } else {
        this.markOffline(agentName);
      }
    }

    return results;
  }

  /**
   * Merge results from multiple agents into a flat array, tagging each item
   * with the source agent name.
   */
  private mergeResults<T>(resultsByAgent: Map<string, T | T[]>): WithAgent<T>[] {
    const merged: WithAgent<T>[] = [];
    for (const [agentName, data] of resultsByAgent) {
      if (Array.isArray(data)) {
        for (const item of data) {
          merged.push({ ...item, agent: agentName });
        }
      } else {
        merged.push({ ...data, agent: agentName });
      }
    }
    return merged;
  }

  private findAgent(name: string): AgentConfig | undefined {
    return this.agents.find((a) => a.name === name);
  }

  private markOnline(name: string): void {
    this.lastSeen.set(name, new Date());
  }

  private markOffline(name: string): void {
    // Only set lastSeen if we have never seen this agent
    // (preserve the last successful timestamp)
    if (!this.lastSeen.has(name)) {
      // never seen — leave null
    }
    // lastSeen stays at whatever it was last set to on success
  }

  private isOnline(name: string): boolean {
    const seen = this.lastSeen.get(name);
    if (!seen) return false;
    // Consider online if seen within the last 30 seconds
    return Date.now() - seen.getTime() < 30_000;
  }
}

// ---------------------------------------------------------------------------
// Singleton factory
// ---------------------------------------------------------------------------

export function createAgentClient(config: NexusConfig): AgentClient {
  return new AgentClient(config.agents);
}
