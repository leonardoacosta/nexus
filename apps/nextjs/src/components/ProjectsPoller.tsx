"use client";

import { useState, useEffect, useCallback } from "react";
import type { CanonicalProject } from "@nexus/core";
import { fetchProjects } from "@/app/actions/projects";
import { ProjectCard } from "./ProjectCard";

interface ProjectsPollerProps {
  initialProjects: CanonicalProject[];
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
        <p style={{ fontSize: "var(--font-size-lg)" }}>No projects in registry</p>
        <p style={{ fontSize: "var(--font-size-sm)", marginTop: "var(--space-2)" }}>
          Projects appear here once agents scan and register them. Make sure agents are running.
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
        <ProjectCard key={project.id} project={project} />
      ))}
    </div>
  );
}
