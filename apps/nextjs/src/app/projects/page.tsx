// Project data comes from live agent sessions — must render on each request
export const dynamic = "force-dynamic";

import { fetchProjects } from "../actions/projects";
import { ProjectsPoller } from "@/components/ProjectsPoller";

export default async function ProjectsPage() {
  const { projects, tagGroups } = await fetchProjects();

  return (
    <div>
      <h1
        style={{
          fontSize: "var(--font-size-2xl)",
          fontWeight: "var(--font-weight-bold)",
          color: "var(--color-fg)",
          marginBottom: "var(--space-6)",
          letterSpacing: "var(--tracking-tight)",
        }}
      >
        Projects
      </h1>
      <ProjectsPoller initialProjects={projects} initialTagGroups={tagGroups} />
    </div>
  );
}
