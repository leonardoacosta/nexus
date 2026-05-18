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
import { createLogger } from "@nexus/core/node";
import { spawn } from "node:child_process";
import type { SessionManager } from "../session-manager";

// Module-level handle so the route doesn't need a constructor.
// Initialised from index.ts via `initSendTextRoute(sessionManager)` on
// startup. Lazy-checked at request time so tests can opt in piecemeal.
let _sessionManager: SessionManager | null = null;

export function initSendTextRoute(sessionManager: SessionManager): void {
  _sessionManager = sessionManager;
}

export function resetSendTextRoute(): void {
  _sessionManager = null;
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
 * Run `tmux send-keys -t <target> <text> [Enter]` and resolve to the
 * tuple { code, stderr }. Never throws.
 */
function tmuxSendKeys(
  target: string,
  text: string,
  appendNewline: boolean,
): Promise<{ code: number; stderr: string }> {
  return new Promise((resolve) => {
    const args = ["send-keys", "-t", target, text];
    if (appendNewline) args.push("Enter");
    const child = spawn("tmux", args, { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on("error", (err) => {
      resolve({ code: -1, stderr: err.message });
    });
    child.on("close", (code) => {
      resolve({ code: code ?? -1, stderr });
    });
  });
}

export async function handleSendText(request: Request): Promise<Response> {
  const sessionManager = _sessionManager;
  if (!sessionManager) {
    return jsonError(503, "send-text route not initialised");
  }
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

  const session = sessionManager.getById(sessionId);
  if (!session) {
    return jsonError(404, `session not found: ${sessionId}`);
  }
  const tmuxTarget = session.tmuxTarget;
  if (!tmuxTarget || tmuxTarget.trim() === "") {
    return jsonError(409, `session has no tmuxTarget: ${sessionId}`);
  }

  const { code, stderr } = await tmuxSendKeys(tmuxTarget, text, appendNewline);
  if (code !== 0) {
    log.warn(
      { sessionId, tmuxTarget, code, stderr },
      "tmux send-keys failed",
    );
    return jsonError(500, `tmux send-keys exited ${code}: ${stderr.trim()}`);
  }

  log.info(
    { sessionId, tmuxTarget, bytes: text.length, appendNewline },
    "send-text dispatched",
  );

  return new Response(
    JSON.stringify({ ok: true, sessionId, tmuxTarget }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );
}

function jsonError(status: number, error: string): Response {
  return new Response(
    JSON.stringify({ error }),
    { status, headers: { "Content-Type": "application/json" } },
  );
}
