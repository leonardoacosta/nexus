"use client";

import { useState, useEffect, useCallback } from "react";
import type { DiscoveredProject } from "@nexus/core";
import type { WithAgent } from "@/lib/agent-client";
import { fetchProjects } from "@/app/actions/projects";
import { ProjectCard } from "./ProjectCard";

interface ProjectsPollerProps {
  initialProjects: WithAgent<DiscoveredProject>[];
}

export function ProjectsPoller({ initialProjects }: ProjectsPollerProps) {
  const [projects, setProjects] = useState(initialProjects);

  const poll = useCallback(async () => {
    try {
      const result = await fetchProjects();
      setProjects(result.projects);
    } catch {
      // Keep existing data on failure
    }
  }, []);

  useEffect(() => {
    const interval = setInterval(poll, 5000);
    return () => clearInterval(interval);
  }, [poll]);

  if (projects.length === 0) {
    return (
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
        <p style={{ fontSize: "var(--font-size-lg)" }}>No projects found</p>
        <p style={{ fontSize: "var(--font-size-sm)", marginTop: "var(--space-2)" }}>
          No projects found. Make sure agents are running and NEXUS_PROJECTS_DIR is configured.
        </p>
      </div>
    );
  }

  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "repeat(auto-fill, minmax(360px, 1fr))",
        gap: "var(--space-4)",
      }}
    >
      {projects.map((project) => (
        <ProjectCard key={`${project.agent}-${project.name}`} project={project} />
      ))}
    </div>
  );
}
