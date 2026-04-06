export const dynamic = "force-dynamic";

import Link from "next/link";
import { fetchSessions } from "@/app/actions/sessions";
import { fetchProject } from "@/app/actions/projects";
import { SessionCard } from "@/components/SessionCard";
import { ProjectSettingsPanel } from "@/components/ProjectSettingsPanel";

export default async function ProjectDetailPage({
  params,
}: {
  params: Promise<{ name: string }>;
}) {
  const { name } = await params;
  const projectName = decodeURIComponent(name);
  const [{ sessions }, canonicalProject] = await Promise.all([
    fetchSessions(),
    fetchProject(projectName),
  ]);

  const filtered = sessions.filter(
    (s) => s.project === projectName || (s.project === null && projectName === "Unassigned"),
  );

  return (
    <div>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: "var(--space-3)",
          marginBottom: "var(--space-6)",
        }}
      >
        <Link
          href="/projects"
          style={{
            color: "var(--color-primary)",
            textDecoration: "none",
            fontSize: "var(--font-size-sm)",
          }}
        >
          &larr; Back to Projects
        </Link>
        <span style={{ color: "var(--color-fg-ghost)" }}>/</span>
        <span
          style={{
            fontSize: "var(--font-size-sm)",
            color: "var(--color-fg-dim)",
          }}
        >
          {projectName}
        </span>
      </div>

      <h1
        style={{
          fontSize: "var(--font-size-2xl)",
          fontWeight: "var(--font-weight-bold)",
          color: "var(--color-fg)",
          marginBottom: "var(--space-6)",
          letterSpacing: "var(--tracking-tight)",
        }}
      >
        {projectName}
      </h1>

      {canonicalProject === null ? (
        <p
          style={{
            fontSize: "var(--font-size-sm)",
            color: "var(--color-fg-muted)",
            marginBottom: "var(--space-6)",
          }}
        >
          Project not found in registry
        </p>
      ) : (
        <ProjectSettingsPanel project={canonicalProject} />
      )}

      {filtered.length === 0 ? (
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            justifyContent: "center",
            padding: "var(--space-16) var(--space-4)",
            color: "var(--color-fg-muted)",
            textAlign: "center",
          }}
        >
          <p style={{ fontSize: "var(--font-size-lg)" }}>
            No sessions for this project
          </p>
        </div>
      ) : (
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fill, minmax(320px, 1fr))",
            gap: "var(--space-3)",
          }}
        >
          {filtered.map((session) => (
            <SessionCard key={session.id} session={session} />
          ))}
        </div>
      )}
    </div>
  );
}
