/**
 * Browser REST client for the Nexus agent HTTP API — session list + create.
 *
 * Mirrors the Swift `NexusClient.fetchSessions` / `startSession`
 * (`apps/swift/NexusShared/Networking/NexusClient.swift`). Endpoints
 * (`apps/agent/src/routes/sessions.ts`):
 *
 *   - `GET  /sessions[?withFingerprint=true&status=…&project=…]` — active +
 *       recent rows (the agent merges a 24h window). Returns a bare JSON array
 *       of session rows.
 *   - `GET  /sessions/:id` — a single session row, 404 if missing.
 *   - `POST /session/start` — `{ project, path, spec_slug? }` spawns a new
 *       Claude Code session in a tmux window and persists a row; responds with
 *       `{ session_name, started, session_id?, pid?, … }`.
 *
 * Sessions persist server-side (tmux + agent Postgres), so the list survives
 * browser reloads — `listSessions()` always reflects the agent's current
 * active set.
 *
 * This client defines its OWN browser DTOs rather than importing `@nexus/db`'s
 * `SessionRow` ($inferSelect) — the DB package is server-only and would pull
 * Drizzle/postgres into the browser bundle, and leaking $inferSelect would
 * couple the web UI to persistence columns. The DTO covers the fields the UI
 * needs; the agent's JSON is a superset and extra keys are ignored.
 */

import { toHttpUrl } from "./agent-config";

// ── DTOs ─────────────────────────────────────────────────────────────────────

/**
 * Browser-side session summary. Timestamps arrive as ISO strings (the agent
 * JSON-serializes Drizzle `Date` columns). Only the UI-relevant subset of the
 * agent's row is typed; unknown extra keys are preserved at runtime but not
 * part of the contract.
 */
export interface SessionSummary {
  id: string;
  machine: string;
  status: string;
  /** ISO timestamp string. */
  startedAt: string;
  /** ISO timestamp string. */
  lastActivity: string;
  /** ISO timestamp string or null when still running. */
  endedAt: string | null;
  projectId: string | null;
  cwd: string | null;
  branch: string | null;
  model: string | null;
  spec: string | null;
  sessionType: string | null;
  /** Sub-agent tree linkage. */
  parentSessionId: string | null;
  childRole: string | null;
  /** Derived agent state: `blocked` | `waiting` | `ready` | null. */
  agentState: string | null;
}

/** Response from `POST /session/start`. */
export interface StartSessionResult {
  sessionName: string;
  started: boolean;
  sessionId?: string;
  pid?: number;
  specLinked?: boolean;
  specLinkError?: string;
}

/** Input for `POST /session/start`. */
export interface StartSessionInput {
  project: string;
  path: string;
  specSlug?: string;
}

/** Optional filters for {@link listSessions}. */
export interface ListSessionsOptions {
  /** Filter to fingerprinted (real CC) rows. Default `true`. */
  withFingerprint?: boolean;
  /** Filter by lifecycle status (`active` | `idle` | `ended` | …). */
  status?: string;
  /** Filter by project id (uuid). */
  project?: string;
  /** Abort signal for cancellation (used by the poll helper). */
  signal?: AbortSignal;
}

/** Thrown on non-2xx responses so callers can branch on `status`. */
export class AgentHttpError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "AgentHttpError";
  }
}

// ── Client ───────────────────────────────────────────────────────────────────

/**
 * Default per-request deadline. fetch has NO built-in timeout — without one,
 * a connected-but-silent agent socket pends forever and stalls pollSessions
 * (its next tick is scheduled in `finally`, which a hung await never reaches).
 * 10s: comfortably above tailnet round-trip, short enough that the 3s poll
 * loop self-heals quickly. Ticks never overlap (next tick is scheduled only
 * after the current one settles), so a timing-out tick just delays the list
 * refresh by up to the deadline.
 */
const DEFAULT_TIMEOUT_MS = 10_000;

/** `POST /session/start` spawns tmux + a Claude Code process on the agent — allow a longer budget. */
const START_SESSION_TIMEOUT_MS = 30_000;

export class AgentRestClient {
  constructor(
    private readonly agentBaseUrl: string,
    private readonly defaultTimeoutMs: number = DEFAULT_TIMEOUT_MS,
  ) {}

  /**
   * `GET /sessions` — active + recent sessions. Defaults to
   * `withFingerprint=true` (real CC rows only), matching the Swift dashboard.
   */
  async listSessions(opts: ListSessionsOptions = {}): Promise<SessionSummary[]> {
    const withFingerprint = opts.withFingerprint ?? true;
    const params = new URLSearchParams();
    if (withFingerprint) params.set("withFingerprint", "true");
    if (opts.status) params.set("status", opts.status);
    if (opts.project) params.set("project", opts.project);
    const qs = params.toString();
    const path = qs ? `/sessions?${qs}` : "/sessions";
    const res = await this.request(path, {
      method: "GET",
      headers: { Accept: "application/json" },
      signal: opts.signal,
      cache: "no-store",
    });
    if (!res.ok) {
      throw new AgentHttpError(res.status, `GET /sessions -> ${res.status}`);
    }
    const rows = (await res.json()) as SessionSummary[];
    return Array.isArray(rows) ? rows : [];
  }

  /** `GET /sessions/:id` — single session, or `null` on 404. */
  async getSession(
    id: string,
    signal?: AbortSignal,
  ): Promise<SessionSummary | null> {
    const res = await this.request(`/sessions/${encodeURIComponent(id)}`, {
      method: "GET",
      headers: { Accept: "application/json" },
      signal,
      cache: "no-store",
    });
    if (res.status === 404) return null;
    if (!res.ok) {
      throw new AgentHttpError(res.status, `GET /sessions/${id} -> ${res.status}`);
    }
    return (await res.json()) as SessionSummary;
  }

  /**
   * `POST /session/start` — spawn a new managed session. The tmux window is
   * created even if spec linkage fails (the agent reports `spec_linked: false`
   * + `spec_link_error` rather than a non-2xx). Throws {@link AgentHttpError}
   * on a non-2xx (missing tmux, bad path, etc.).
   */
  async startSession(input: StartSessionInput): Promise<StartSessionResult> {
    const body: Record<string, string> = {
      project: input.project,
      path: input.path,
    };
    if (input.specSlug) body.spec_slug = input.specSlug;
    const res = await this.request("/session/start", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify(body),
      timeoutMs: START_SESSION_TIMEOUT_MS,
    });
    if (!res.ok) {
      let detail = "";
      try {
        const err = (await res.json()) as { error?: string };
        detail = err.error ? `: ${err.error}` : "";
      } catch {
        // non-JSON error body
      }
      throw new AgentHttpError(
        res.status,
        `POST /session/start -> ${res.status}${detail}`,
      );
    }
    const json = (await res.json()) as {
      session_name: string;
      started: boolean;
      session_id?: string;
      pid?: number;
      spec_linked?: boolean;
      spec_link_error?: string;
    };
    return {
      sessionName: json.session_name,
      started: json.started,
      sessionId: json.session_id,
      pid: json.pid,
      specLinked: json.spec_linked,
      specLinkError: json.spec_link_error,
    };
  }

  private http(path: string): string {
    const url = toHttpUrl(this.agentBaseUrl, path);
    if (!url) {
      throw new AgentHttpError(0, `unconstructable agent URL for ${path}`);
    }
    return url;
  }

  /**
   * Single execution point for all agent HTTP calls. Injects a default
   * timeout so no request can pend forever; a caller-supplied cancellation
   * signal is combined via AbortSignal.any (whichever aborts first wins).
   * Timeout rejection surfaces as a DOMException named "TimeoutError" —
   * distinct from the "AbortError" that pollSessions deliberately swallows.
   */
  private async request(
    path: string,
    init: RequestInit & { timeoutMs?: number } = {},
  ): Promise<Response> {
    const { timeoutMs = this.defaultTimeoutMs, signal, ...rest } = init;
    const timeout = AbortSignal.timeout(timeoutMs);
    return fetch(this.http(path), {
      ...rest,
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    });
  }
}

// ── Poll helper ──────────────────────────────────────────────────────────────

/** Handle returned by {@link pollSessions} — call `stop()` to cancel. */
export interface SessionPoll {
  stop(): void;
}

/**
 * Keep a caller's session list live by polling `GET /sessions` on an interval.
 * Invokes `onSessions` with each fresh list and `onError` on failures (the
 * loop keeps running after an error so a transient agent blip self-heals).
 * Fires once immediately, then every `intervalMs`. Call `stop()` to cancel;
 * cancellation aborts any in-flight request.
 *
 * The UI batch wires this into the home view so the list reflects sessions
 * started elsewhere (and survives reloads, since state is server-persisted).
 */
export function pollSessions(
  client: AgentRestClient,
  onSessions: (sessions: SessionSummary[]) => void,
  opts: {
    intervalMs?: number;
    onError?: (err: unknown) => void;
    listOptions?: Omit<ListSessionsOptions, "signal">;
  } = {},
): SessionPoll {
  const intervalMs = opts.intervalMs ?? 3_000;
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let controller: AbortController | null = null;

  const tick = async () => {
    if (stopped) return;
    controller = new AbortController();
    try {
      const sessions = await client.listSessions({
        ...opts.listOptions,
        signal: controller.signal,
      });
      if (!stopped) onSessions(sessions);
    } catch (err) {
      // AbortError on stop() is expected — swallow it.
      if (!stopped && !(err instanceof DOMException && err.name === "AbortError")) {
        opts.onError?.(err);
      }
    } finally {
      if (!stopped) {
        timer = setTimeout(() => void tick(), intervalMs);
      }
    }
  };

  void tick();

  return {
    stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
      controller?.abort();
    },
  };
}
