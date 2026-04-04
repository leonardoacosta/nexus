import Link from "next/link";
import type { Project } from "@nexus/core";
import type { WithAgent } from "@/lib/agent-client";
import { Badge } from "@nexus/ui";

interface ProjectCardProps {
  project: WithAgent<Project>;
}

export function ProjectCard({ project }: ProjectCardProps) {
  return (
    <Link
      href={`/projects/${encodeURIComponent(project.name)}`}
      style={{ textDecoration: "none", color: "inherit", display: "block" }}
    >
      <div
        style={{
          background: "var(--color-surface)",
          border: "1px solid var(--color-border)",
          borderRadius: "var(--radius-lg)",
          padding: "var(--space-4)",
          transition: "border-color var(--transition-fast)",
          cursor: "pointer",
        }}
        onMouseEnter={(e) => {
          (e.currentTarget as HTMLElement).style.borderColor =
            "var(--color-border-bright)";
        }}
        onMouseLeave={(e) => {
          (e.currentTarget as HTMLElement).style.borderColor =
            "var(--color-border)";
        }}
      >
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            marginBottom: "var(--space-3)",
          }}
        >
          <h3
            style={{
              fontSize: "var(--font-size-base)",
              fontWeight: "var(--font-weight-semibold)",
              color: "var(--color-fg)",
            }}
          >
            {project.name}
          </h3>
          <div style={{ display: "flex", gap: "var(--space-2)" }}>
            <Badge variant={project.active_sessions > 0 ? "success" : "default"}>
              {project.active_sessions} active
            </Badge>
            <Badge>{project.total_sessions} total</Badge>
          </div>
        </div>
        <div
          style={{
            display: "flex",
            gap: "var(--space-1)",
            flexWrap: "wrap",
          }}
        >
          {project.machines.map((machine) => (
            <Badge key={machine}>{machine}</Badge>
          ))}
        </div>
      </div>
    </Link>
  );
}
