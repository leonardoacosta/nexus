import { fetchProjects } from "../actions/projects";
import { ProjectsPoller } from "@/components/ProjectsPoller";

export default async function ProjectsPage() {
  const { projects } = await fetchProjects();

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
      <ProjectsPoller initialProjects={projects} />
    </div>
  );
}
