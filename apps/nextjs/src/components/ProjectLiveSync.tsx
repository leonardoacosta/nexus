"use client";

/**
 * ProjectLiveSync
 *
 * Renderless client subcomponent mounted inside the project-detail RSC
 * page. Subscribes to the same-origin SSE proxy and triggers
 * `router.refresh()` whenever a `HookEventReceived` event arrives whose
 * payload `project` matches the decoded URL segment.
 *
 * `router.refresh()` re-runs the page's parallel `fetchSessions()` +
 * `fetchProject()` calls so the session-count and last-activity badges
 * update without a full reload.
 *
 * Spec: openspec/changes/add-hooks-sse-fanout/specs/hooks-endpoint/spec.md
 *       § "Project page filters by project"
 */

import { useCallback } from "react";
import { useRouter } from "next/navigation";

import {
  isHookEventForProject,
  useHookEvents,
} from "@/lib/hooks/use-hook-events";

interface ProjectLiveSyncProps {
  project: string;
}

export function ProjectLiveSync({ project }: ProjectLiveSyncProps) {
  const router = useRouter();
  const predicate = isHookEventForProject(project);
  const onMatch = useCallback(() => {
    router.refresh();
  }, [router]);

  useHookEvents(predicate, onMatch);

  return null;
}
