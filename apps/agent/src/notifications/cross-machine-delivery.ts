/**
 * Cross-machine forward (openspec/changes/cross-machine-delivery, Phase 1.6).
 *
 * When `resolveLiveConsole` resolves a target machine that is NOT local, the
 * originating agent POSTs the notification to that peer's
 * `POST /notifications/deliver` (host:port from `agent-registry`). The peer
 * emits `NotificationFired` locally so ITS Mac renders the banner/TTS.
 *
 * Lossless fallback: on ANY failure (target unknown, fetch throws, non-2xx),
 * `forwardOrLocal` returns `false` so the caller delivers locally instead — a
 * notification is NEVER dropped because a peer was unreachable. It returns
 * `true` only when the peer accepted the forward (2xx).
 *
 * Loop guard: a notification that arrived via `/notifications/deliver` carries
 * `forwarded: true` and is NEVER re-forwarded.
 *
 * Deps (fetch + peer lookup + secret) are injected so this is unit-testable
 * without a live peer.
 */

import { createLogger } from "@nexus/core/node";
import type { PeerAddress } from "../db/agent-registry";

/**
 * Lazy accessor, NOT a module-load-time `const log = createLogger(...)`.
 *
 * `mock.module("@nexus/core/node", ...)` is process-global + applies to the
 * CURRENT registry entry at call time. A module-scope const binds whichever
 * `createLogger` implementation was live when THIS module first loaded —
 * if some other test file transitively imports this module before installing
 * its own `@nexus/core/node` mock (or never mocks it), that first binding
 * wins for the rest of the process and later suites' logger spies never see
 * the calls (nx-vvl52). Calling `createLogger()` fresh on each use instead
 * always resolves against whatever mock (if any) is installed at call time.
 */
function getLog() {
  return createLogger("agent:notifications:cross-machine-delivery");
}

/** Timeout for the peer forward POST — fail fast to the local fallback. */
export const FORWARD_TIMEOUT_MS = 3_000;

/**
 * The transport-safe projection of a notification forwarded to a peer. Mirrors
 * the `NotificationFired` payload fields the peer needs to render; carries the
 * `forwarded` loop-guard flag.
 */
export interface ForwardableNotification {
  id: string;
  title: string;
  body: string;
  channel: string;
  project?: string;
  items?: string[];
  logPath?: string;
  sessionName?: string;
  sessionId?: string;
  /** True when this notification already arrived via a forward — never re-forward. */
  forwarded?: boolean;
}

/**
 * The minimal fetch call signature `forwardOrLocal` needs. Narrower than the
 * full `typeof fetch` (no `preconnect`) so plain test lambdas satisfy it.
 */
export type FetchLike = (
  url: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

/** Injectable collaborators so `forwardOrLocal` runs without a live peer. */
export interface ForwardDeps {
  /** Resolve the target machine's host:port (agent-registry lookup). */
  lookupPeer: (machine: string) => Promise<PeerAddress | null>;
  /** The fetch implementation (injected for tests). */
  fetchImpl: FetchLike;
  /** Shared agent secret sent as `x-nexus-secret` on the forward POST. */
  secret: string | undefined;
}

/**
 * Forward to the target peer, or signal local delivery.
 *
 * @returns `true` iff the peer accepted the forward (2xx). `false` means the
 *   caller MUST deliver locally — covers the local-target case, the loop-guard
 *   case, and every failure mode (lossless fallback).
 */
export async function forwardOrLocal(
  notification: ForwardableNotification,
  targetMachine: string,
  localMachine: string,
  deps: ForwardDeps,
): Promise<boolean> {
  // Local target → caller delivers locally, no forward.
  if (targetMachine === localMachine) return false;

  // Loop guard → a forwarded notification is rendered locally, never re-forwarded.
  if (notification.forwarded) return false;

  let peer: PeerAddress | null;
  try {
    peer = await deps.lookupPeer(targetMachine);
  } catch (err) {
    getLog().warn(
      { targetMachine, err: err instanceof Error ? err.message : String(err) },
      "cross-machine forward: peer lookup failed — falling back to local delivery",
    );
    return false;
  }

  if (!peer) {
    getLog().warn(
      { targetMachine },
      "cross-machine forward: target peer not in registry — falling back to local delivery",
    );
    return false;
  }

  const url = `http://${peer.host}:${peer.port}/notifications/deliver`;
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (deps.secret) headers["x-nexus-secret"] = deps.secret;

  // The peer marks the rendered notification forwarded so it can never bounce
  // back through another forward hop.
  const body: ForwardableNotification = { ...notification, forwarded: true };

  try {
    const res = await deps.fetchImpl(url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(FORWARD_TIMEOUT_MS),
    });
    if (!res.ok) {
      getLog().warn(
        { targetMachine, url, status: res.status },
        "cross-machine forward: peer returned non-2xx — falling back to local delivery",
      );
      return false;
    }
    getLog().info({ targetMachine, url, id: notification.id }, "cross-machine forward: peer accepted");
    return true;
  } catch (err) {
    getLog().warn(
      {
        targetMachine,
        url,
        err: err instanceof Error ? err.message : String(err),
      },
      "cross-machine forward: peer unreachable/timeout — falling back to local delivery",
    );
    return false;
  }
}
