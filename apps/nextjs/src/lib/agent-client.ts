import type {
  AgentConfig,
  NexusConfig,
  Session,
  HealthMetrics,
  Project,
  DiscoveredProject,
} from "@nexus/core";

// ---------------------------------------------------------------------------
// Agent wire types (what the agent's GET /projects/discovered actually returns)
// ---------------------------------------------------------------------------

/** Project entry as returned by the agent endpoint (before client mapping). */
interface AgentProject {
  name: string;
  path: string;
  activeSessions?: number;
  totalSessions?: number;
  /** Git remote URL for origin; stable cross-machine identity key. Optional — old agents omit it. */
  gitRemoteUrl?: string | null;
}

/** Wire response from GET /projects/discovered. */
interface AgentDiscoveredResponse {
  projects: AgentProject[];
  truncated: boolean;
  configured?: boolean;
}

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

export class TtlCache {
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
      const res = await fetch(url, {
        signal: controller.signal,
        headers: { "x-nexus-secret": process.env.NEXUS_ATTACH_SECRET ?? "" },
      });
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

/** Internal tracking entry for aggregated discovered projects. */
interface DiscoveredProjectEntry {
  entry: WithAgent<DiscoveredProject> & { machineCount: number };
  /** Unix ms timestamp of the last time any agent reported this project. */
  lastSeenAt: number;
}

export class AgentClient {
  private agents: AgentConfig[];
  private lastSeen = new Map<string, Date>();
  private cache = new TtlCache();
  /** Persistent cross-agent dedup map keyed by normalized project path. */
  private discoveredProjectsMap = new Map<string, DiscoveredProjectEntry>();

  constructor(agents: AgentConfig[], cache?: TtlCache) {
    this.agents = agents;
    if (cache) {
      this.cache = cache;
    }
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

  async fetchDiscoveredProjects(): Promise<WithAgent<DiscoveredProject>[]> {
    return this.cache.get("all-discovered-projects", CACHE_TTL_LONG_MS, async () => {
      const settled = await Promise.allSettled(
        this.agents.map(async (agent) => {
          const res = await fetchWithRetry(`${agentBaseUrl(agent)}/projects/discovered`);
          const data = (await res.json()) as AgentDiscoveredResponse;
          this.markOnline(agent.name);
          return { name: agent.name, data };
        }),
      );

      // Stale eviction: drop entries not seen by any agent in the last hour.
      const STALE_TTL_MS = 60 * 60 * 1_000;
      const now = Date.now();
      for (const [key, entry] of this.discoveredProjectsMap) {
        if (now - entry.lastSeenAt > STALE_TTL_MS) {
          this.discoveredProjectsMap.delete(key);
        }
      }

      for (let i = 0; i < settled.length; i++) {
        const result = settled[i]!;
        const agentName = this.agents[i]!.name;
        if (result.status === "fulfilled") {
          for (const project of result.value.data.projects) {
            // Dedup key: prefer git remote URL as canonical cross-machine key (stable across
            // different home dirs). Fall back to normalized absolute path for projects without
            // a remote. Normalize case on macOS (case-insensitive FS), preserve on Linux.
            const normalizedPath =
              process.platform === "darwin"
                ? project.path.toLowerCase()
                : project.path;
            const key = project.gitRemoteUrl ?? normalizedPath;

            const activeSessions = project.activeSessions ?? 0;
            const totalSessions = project.totalSessions ?? 0;

            const existing = this.discoveredProjectsMap.get(key);
            if (existing) {
              // Accumulate counts across agents; do NOT overwrite the agent field.
              existing.entry.active_sessions += activeSessions;
              existing.entry.total_sessions += totalSessions;
              existing.entry.machineCount = (existing.entry.machineCount ?? 1) + 1;
              existing.lastSeenAt = now;
            } else {
              // Map agent wire format → core DiscoveredProject
              const mapped: WithAgent<DiscoveredProject> & { machineCount: number } = {
                name: project.name,
                path: project.path,
                active_sessions: activeSessions,
                total_sessions: totalSessions,
                agent: result.value.name,
                machineCount: 1,
              };
              this.discoveredProjectsMap.set(key, { entry: mapped, lastSeenAt: now });
            }
          }
        } else {
          this.markOffline(agentName);
        }
      }

      return Array.from(this.discoveredProjectsMap.values()).map((v) => v.entry);
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

  async startSession(
    agentName: string,
    body: { project: string; path: string },
  ): Promise<{ session_name: string; started: boolean }> {
    const agent = this.findAgent(agentName);
    if (!agent) throw new Error(`Agent not found: ${agentName}`);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const res = await fetch(`${agentBaseUrl(agent)}/session/start`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-nexus-secret": process.env.NEXUS_ATTACH_SECRET ?? "",
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      clearTimeout(timer);
      if (!res.ok) {
        const text = await res.text();
        let message: string;
        try {
          const parsed = JSON.parse(text) as { error?: string };
          message = parsed.error ?? `HTTP ${res.status}`;
        } catch {
          message = text || `HTTP ${res.status}`;
        }
        throw new Error(message);
      }
      this.markOnline(agentName);
      return (await res.json()) as { session_name: string; started: boolean };
    } catch (err) {
      clearTimeout(timer);
      this.markOffline(agentName);
      throw err;
    }
  }

  async fetchAgentSelf(agentName: string): Promise<{
    name: string;
    host: string;
    port: number;
    role: string;
    projects_dir: string;
  } | null> {
    const agent = this.findAgent(agentName);
    if (!agent) return null;
    try {
      const res = await fetchWithRetry(`${agentBaseUrl(agent)}/agent/self`);
      this.markOnline(agentName);
      return (await res.json()) as {
        name: string;
        host: string;
        port: number;
        role: string;
        projects_dir: string;
      };
    } catch {
      this.markOffline(agentName);
      return null;
    }
  }

  async fetchAgentCommands(agentName: string): Promise<{
    commands: Array<{
      name: string;
      namespace: string;
      full_name: string;
      description: string;
      tier: string;
      cost: string;
    }>;
  } | null> {
    const agent = this.findAgent(agentName);
    if (!agent) return null;
    try {
      const res = await fetchWithRetry(`${agentBaseUrl(agent)}/commands`);
      this.markOnline(agentName);
      return (await res.json()) as {
        commands: Array<{
          name: string;
          namespace: string;
          full_name: string;
          description: string;
          tier: string;
          cost: string;
        }>;
      };
    } catch {
      this.markOffline(agentName);
      return null;
    }
  }

  async updateCommand(
    agentName: string,
    name: string,
    content: string,
  ): Promise<{ updated: boolean; path: string }> {
    const agent = this.findAgent(agentName);
    if (!agent) throw new Error(`Agent not found: ${agentName}`);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const res = await fetch(
        `${agentBaseUrl(agent)}/commands/${encodeURIComponent(name)}`,
        {
          method: "PUT",
          headers: {
            "Content-Type": "application/json",
            "x-nexus-secret": process.env.NEXUS_ATTACH_SECRET ?? "",
          },
          body: JSON.stringify({ content }),
          signal: controller.signal,
        },
      );
      clearTimeout(timer);
      if (!res.ok) {
        const err = (await res.json()) as { error?: string };
        throw new Error(err.error ?? `HTTP ${res.status}`);
      }
      this.markOnline(agentName);
      return (await res.json()) as { updated: boolean; path: string };
    } catch (err) {
      clearTimeout(timer);
      throw err;
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
