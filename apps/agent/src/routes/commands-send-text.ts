/**
 * POST /commands/send-text — forward text into a session's tmux pane.
 *
 * Spec: openspec/changes/scaffold-nexus-watch-target (task 1.2)
 *
 * Used by:
 *   - watchOS notification action handlers (Approve / Deny / Custom)
 *   - iOS quick-reply (future)
 *
 * Request shape:
 *   POST /commands/send-text
 *   { sessionId: string, text: string, appendNewline?: boolean }
 *
 * The handler resolves the session row (must have a tmuxTarget), then
 * shells out to `tmux send-keys -t <tmuxTarget> <text> [Enter]`. The text
 * is passed as a single argument so spaces and special characters survive.
 *
 * On success returns 200 { ok: true }. On any failure (missing session,
 * no tmux target, tmux not installed, send-keys non-zero) returns 4xx/5xx
 * with `{ error: string }`.
 */
import { createLogger, safeSpawn } from "@nexus/core/node";
import { isValidTmuxTarget } from "../terminal/tmux-pty-source";
import type { SessionManager } from "../session-manager";

// Module-level handle so the route doesn't need a constructor.
// Initialised from index.ts via `initSendTextRoute(sessionManager)` on
// startup. Lazy-checked at request time so tests can opt in piecemeal.
let _sessionManager: SessionManager | null = null;

// Injectable spawn impl (default: real safeSpawn). Tests pass a recording
// fake — mirrors the SpawnFns injection pattern in terminal/tmux-pty-source.ts.
let _spawn: typeof safeSpawn = safeSpawn;

export function initSendTextRoute(
  sessionManager: SessionManager,
  spawnImpl: typeof safeSpawn = safeSpawn,
): void {
  _sessionManager = sessionManager;
  _spawn = spawnImpl;
}

export function resetSendTextRoute(): void {
  _sessionManager = null;
  _spawn = safeSpawn;
}

const log = createLogger("agent:routes:commands-send-text");

interface SendTextBody {
  sessionId: string;
  text: string;
  appendNewline?: boolean;
}

function isSendTextBody(value: unknown): value is SendTextBody {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.sessionId === "string" &&
    v.sessionId.length > 0 &&
    typeof v.text === "string" &&
    (v.appendNewline === undefined || typeof v.appendNewline === "boolean")
  );
}

/**
 * Run `tmux send-keys -t <target> <text> [Enter]` via safeSpawn and resolve
 * to the tuple { code, stderr }. Never throws.
 */
async function tmuxSendKeys(
  target: string,
  text: string,
  appendNewline: boolean,
): Promise<{ code: number; stderr: string }> {
  const args = ["send-keys", "-t", target, text];
  if (appendNewline) args.push("Enter");
  try {
    // trustArgs: `text` is intended keystrokes and may legitimately contain
    // shell metacharacters (; $ \r ...). Safe because this is an argv-vector
    // spawn (no shell) and `target` — the only other non-literal arg — is
    // validated with isValidTmuxTarget before we get here.
    const handle = _spawn("tmux", args, {
      stdio: ["ignore", "ignore", "pipe"],
      trustArgs: true,
    });
    const stderr =
      handle.stderr instanceof ReadableStream
        ? await new Response(handle.stderr).text()
        : "";
    const code = await handle.exitCode;
    return { code, stderr };
  } catch (err) {
    // Bun.spawn throws synchronously when tmux is missing — preserve the old
    // node 'error'-event behavior: code -1, message in stderr (route → 500).
    return { code: -1, stderr: err instanceof Error ? err.message : String(err) };
  }
}

/** Result of `sendTextToSession` — carries the HTTP status the route should map onto. */
export type SendTextResult =
  | { ok: true; tmuxTarget: string }
  | { ok: false; status: number; error: string };

/**
 * Resolve `sessionId`'s tmux target and send `text` via `tmux send-keys`.
 *
 * Extracted from `handleSendText` (wire-reactive-rate-limit-swap, task 2.3)
 * so the reactive-swap auto-continue path
 * (`services/socket-server/dispatcher.ts`) can reuse the exact same
 * session-resolution + validation + spawn logic the HTTP route uses,
 * without a loopback HTTP call. Returns a result object instead of throwing
 * so callers can WARN and continue rather than crash the caller.
 */
export async function sendTextToSession(
  sessionId: string,
  text: string,
  appendNewline = true,
): Promise<SendTextResult> {
  const sessionManager = _sessionManager;
  if (!sessionManager) {
    return { ok: false, status: 503, error: "send-text route not initialised" };
  }

  const session = sessionManager.getById(sessionId);
  if (!session) {
    return { ok: false, status: 404, error: `session not found: ${sessionId}` };
  }
  const tmuxTarget = session.tmuxTarget;
  if (!tmuxTarget || tmuxTarget.trim() === "") {
    return { ok: false, status: 409, error: `session has no tmuxTarget: ${sessionId}` };
  }
  if (!isValidTmuxTarget(tmuxTarget)) {
    log.warn({ sessionId, tmuxTarget }, "send-text: rejected invalid tmux target");
    return { ok: false, status: 409, error: `session has invalid tmuxTarget: ${sessionId}` };
  }

  const { code, stderr } = await tmuxSendKeys(tmuxTarget, text, appendNewline);
  if (code !== 0) {
    log.warn(
      { sessionId, tmuxTarget, code, stderr },
      "tmux send-keys failed",
    );
    return { ok: false, status: 500, error: `tmux send-keys exited ${code}: ${stderr.trim()}` };
  }

  log.info(
    { sessionId, tmuxTarget, bytes: text.length, appendNewline },
    "send-text dispatched",
  );

  return { ok: true, tmuxTarget };
}

export async function handleSendText(request: Request): Promise<Response> {
  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return jsonError(400, "invalid JSON body");
  }

  if (!isSendTextBody(raw)) {
    return jsonError(
      400,
      "expected { sessionId: string, text: string, appendNewline?: boolean }",
    );
  }

  const { sessionId, text } = raw;
  const appendNewline = raw.appendNewline ?? true;

  const result = await sendTextToSession(sessionId, text, appendNewline);
  if (!result.ok) {
    return jsonError(result.status, result.error);
  }

  return new Response(
    JSON.stringify({ ok: true, sessionId, tmuxTarget: result.tmuxTarget }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );
}

function jsonError(status: number, error: string): Response {
  return new Response(
    JSON.stringify({ error }),
    { status, headers: { "Content-Type": "application/json" } },
  );
}
