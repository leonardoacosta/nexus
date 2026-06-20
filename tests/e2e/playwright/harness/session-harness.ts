/**
 * Test harness for the web-terminal Playwright suite.
 *
 * Stands up a CONTROLLED, deterministic session that the running Nexus agent
 * (on NEXUS_AGENT_URL, default http://localhost:7400) will lazy-attach to:
 *
 *   1. Spawn a dedicated detached tmux session running a plain `bash`
 *      (`--noprofile --norc`) so its output is deterministic — we control
 *      every byte the pane emits, unlike a `claude` window.
 *   2. Insert a `sessions` row (via `psql`) whose `tmux_target` points at that
 *      pane. The agent's WS upgrade path (`ensurePtyForSession`) reads the row
 *      with `getSessionById` and lazy-attaches a `TmuxPtySource` on first
 *      connect; the 1s-TTL `GET /sessions` cache surfaces the row in the home
 *      list almost immediately.
 *   3. Tear everything down: kill the tmux session + delete the row.
 *
 * We deliberately use `psql` (not the @nexus/db drizzle handle) because this
 * file runs under Node (Playwright), and @nexus/db's postgres-js client is
 * wired for Bun. `psql` is driver-agnostic and already on PATH (verified in
 * the harness env). The column set mirrors
 * `tests/e2e/session-stream-attach.test.ts`'s row exactly.
 *
 * The agent is REUSED, never spawned here — the mission requires testing the
 * real deployed agent on :7400. `assertAgentUp()` fails fast with a clear
 * message if it is not reachable, rather than letting specs time out opaquely.
 */
import { execFileSync } from "node:child_process";

const TS_HOST = process.env.NEXUS_TS_HOST ?? "100.73.182.4";
export const AGENT_URL =
  process.env.NEXUS_AGENT_URL?.replace(/\/+$/, "") ?? `http://${TS_HOST}:7400`;

export const POSTGRES_URL = process.env.POSTGRES_URL ?? "";

/** A live controlled session: its DB id + the backing tmux session/target. */
export interface ControlledSession {
  sessionId: string;
  tmuxSession: string;
  tmuxTarget: string;
}

function sh(cmd: string, args: string[]): string {
  return execFileSync(cmd, args, { encoding: "utf8" }).toString();
}

/** Spawn a detached tmux session running plain bash; resolve its pane target. */
export function spawnTmuxBash(tmuxSession: string): string {
  sh("tmux", [
    "new-session",
    "-d",
    "-s",
    tmuxSession,
    "bash",
    "--noprofile",
    "--norc",
  ]);
  // base-index varies across tmux configs — resolve the actual pane target.
  const out = sh("tmux", ["list-panes", "-t", tmuxSession, "-F", "#S:#I.#P"]);
  const target = out.trim().split("\n")[0];
  if (!target) throw new Error(`tmux list-panes empty for ${tmuxSession}`);
  return target;
}

export function killTmux(tmuxSession: string): void {
  try {
    sh("tmux", ["kill-session", "-t", tmuxSession]);
  } catch {
    // best-effort
  }
}

/**
 * Failure-safe orphan sweep (nx-8kdie): kill every tmux SESSION whose name
 * starts with `prefix` (default the `nx-e2e-` prefix this harness uses). Self-
 * heals sessions leaked by a prior killed/crashed Playwright run. Node-native
 * (execFileSync) twin of `apps/agent/src/testing/tmux-cleanup.ts` — this file
 * runs under Playwright/Node, not Bun, so it can't import the Bun helper.
 * Matches by session NAME prefix, never by index; best-effort throughout.
 *
 * @returns number of sessions killed.
 */
export function sweepTmuxSessionsByPrefix(prefix = "nx-e2e-"): number {
  let out: string;
  try {
    out = sh("tmux", ["list-sessions", "-F", "#{session_name}"]);
  } catch {
    return 0; // no tmux server / no sessions / tmux missing
  }
  let killed = 0;
  for (const name of out.split("\n").map((l) => l.trim()).filter(Boolean)) {
    if (!name.startsWith(prefix)) continue;
    try {
      sh("tmux", ["kill-session", "-t", name]);
      killed++;
    } catch {
      // already gone — best-effort
    }
  }
  return killed;
}

/** Send a line of input + Enter into the backing pane (used by read-only test). */
export function tmuxSendKeys(target: string, text: string): void {
  sh("tmux", ["send-keys", "-t", target, text, "Enter"]);
}

/** Insert the session row via psql. cwd is set so the row is "fingerprinted". */
function insertSessionRow(s: ControlledSession): void {
  if (!POSTGRES_URL) throw new Error("POSTGRES_URL unset — cannot insert row");
  const cwd = process.cwd().replace(/'/g, "''");
  const sql = `INSERT INTO sessions
    (id, machine, status, started_at, last_activity, ended_at, pid, cwd,
     tmux_session, tmux_target, model)
   VALUES
    ('${s.sessionId}', 'local', 'active', now(), now(), NULL, NULL, '${cwd}',
     '${s.tmuxSession}', '${s.tmuxTarget}', 'bash');`;
  sh("psql", [POSTGRES_URL, "-v", "ON_ERROR_STOP=1", "-c", sql]);
}

export function deleteSessionRow(sessionId: string): void {
  if (!POSTGRES_URL) return;
  try {
    sh("psql", [
      POSTGRES_URL,
      "-c",
      `DELETE FROM sessions WHERE id = '${sessionId}';`,
    ]);
  } catch {
    // best-effort cleanup
  }
}

/**
 * Create a controlled session end-to-end: tmux bash window + DB row. Returns
 * the handle; caller is responsible for {@link destroyControlledSession}.
 */
export function createControlledSession(label: string): ControlledSession {
  // Orphan sweep (nx-8kdie): self-heal any nx-e2e-* tmux sessions leaked by a
  // prior killed/crashed Playwright run before we spawn a fresh one. Wiring the
  // sweep HERE (rather than in each spec's beforeAll) means every harness
  // consumer self-heals with no per-spec duplication. Matches by session-NAME
  // prefix; never touches the user's session.
  sweepTmuxSessionsByPrefix("nx-e2e-");
  const uniq = `${process.pid}-${Date.now()}-${Math.floor(Math.random() * 1e4)}`;
  const tmuxSession = `nx-e2e-${label}-${uniq}`;
  const sessionId = `e2e-${label}-${uniq}`;
  const tmuxTarget = spawnTmuxBash(tmuxSession);
  const handle: ControlledSession = { sessionId, tmuxSession, tmuxTarget };
  insertSessionRow(handle);
  return handle;
}

export function destroyControlledSession(s: ControlledSession): void {
  deleteSessionRow(s.sessionId);
  killTmux(s.tmuxSession);
}

/** Fail fast with a clear message if the reused agent is not reachable. */
export async function assertAgentUp(): Promise<void> {
  const url = `${AGENT_URL}/sessions`;
  let res: Response;
  try {
    res = await fetch(url, { headers: { Accept: "application/json" } });
  } catch (err) {
    throw new Error(
      `Nexus agent not reachable at ${url}: ${
        err instanceof Error ? err.message : String(err)
      }. Start one with NEXUS_ATTACH_SECRET=test bun run --filter @nexus/agent dev, ` +
        `or point NEXUS_AGENT_URL at a running agent.`,
    );
  }
  if (!res.ok) {
    throw new Error(`GET ${url} -> ${res.status}; agent unhealthy`);
  }
}
