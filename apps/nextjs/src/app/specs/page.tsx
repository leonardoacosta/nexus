// Spec data comes from live agent — must render on each request
export const dynamic = "force-dynamic";

import { fetchWithTimeout } from "@nexus/core/fetch";
import { getAgentBaseUrl } from "@/lib/agent-url";

import { SpecEventsSubscriber } from "./spec-events-subscriber";
import type { AllSpecsResponse } from "./types";

async function fetchSpecs(baseUrl: string | null): Promise<AllSpecsResponse> {
  if (!baseUrl) return { projects: [] };

  try {
    const res = await fetchWithTimeout(`${baseUrl}/specs/all`, {
      headers: { "x-nexus-secret": process.env.NEXUS_ATTACH_SECRET ?? "" },
      cache: "no-store",
    });
    if (!res.ok) return { projects: [] };
    return (await res.json()) as AllSpecsResponse;
  } catch {
    return { projects: [] };
  }
}

export default async function SpecsPage() {
  const resolved = await getAgentBaseUrl();
  const baseUrl = resolved?.baseUrl ?? null;
  const { projects } = await fetchSpecs(baseUrl);

  return (
    <div>
      <SpecEventsSubscriber
        initialProjects={projects}
        agentBaseUrl={baseUrl}
      />
    </div>
  );
}
