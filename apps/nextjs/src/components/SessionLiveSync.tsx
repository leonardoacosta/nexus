"use client";

/**
 * SessionLiveSync
 *
 * Renderless client subcomponent mounted inside the session-detail RSC page.
 * Subscribes to the same-origin SSE proxy and triggers `router.refresh()`
 * whenever a `HookEventReceived` event arrives whose payload `sessionId`
 * matches the page's session id.
 *
 * `router.refresh()` invalidates the RSC cache for the current segment, so
 * the next render re-runs `fetchSessionDetail(id)` and the timeline
 * re-renders with the new event appended. This keeps the data layer in
 * Server Components — no client-side state mirroring required.
 *
 * Spec: openspec/changes/add-hooks-sse-fanout/specs/hooks-endpoint/spec.md
 *       § "Session detail page filters by sessionId"
 */

import { useCallback } from "react";
import { useRouter } from "next/navigation";

import {
  isHookEventForSession,
  useHookEvents,
} from "@/lib/hooks/use-hook-events";

interface SessionLiveSyncProps {
  sessionId: string;
}

export function SessionLiveSync({ sessionId }: SessionLiveSyncProps) {
  const router = useRouter();
  const predicate = isHookEventForSession(sessionId);
  const onMatch = useCallback(() => {
    router.refresh();
  }, [router]);

  useHookEvents(predicate, onMatch);

  return null;
}
