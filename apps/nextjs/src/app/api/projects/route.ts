import { NextResponse } from "next/server";
import { getReadOnlyDb } from "@/lib/db";
import { projects, projectLocations, agents, eq } from "@nexus/db";
import { PROJECT_SELECT_FIELDS, buildCanonicalProjects } from "@/lib/projects";

export const dynamic = "force-dynamic";

export async function GET(): Promise<NextResponse> {
  try {
    const db = getReadOnlyDb();

    const rows = await db
      .select(PROJECT_SELECT_FIELDS)
      .from(projects)
      .leftJoin(projectLocations, eq(projectLocations.projectId, projects.id))
      .leftJoin(agents, eq(agents.id, projectLocations.agentId))
      .where(eq(projects.status, "active"));

    // Sort: activeSessions DESC, then name ASC
    const result = buildCanonicalProjects(rows).sort((a, b) => {
      if (b.activeSessions !== a.activeSessions) return b.activeSessions - a.activeSessions;
      return a.name.localeCompare(b.name);
    });

    return NextResponse.json(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
