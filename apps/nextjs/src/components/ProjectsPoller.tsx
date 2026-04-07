"use client";

import { useState, useEffect, useCallback } from "react";
import type { CanonicalProject } from "@nexus/core";
import type { TagGroupSummary } from "@/app/actions/projects";
import { fetchProjects } from "@/app/actions/projects";
import { ProjectsTable } from "./ProjectsTable";

interface ProjectsPollerProps {
  initialProjects: CanonicalProject[];
  initialTagGroups?: TagGroupSummary[];
}

export function ProjectsPoller({ initialProjects, initialTagGroups }: ProjectsPollerProps) {
  const [projects, setProjects] = useState(initialProjects);
  const [tagGroups, setTagGroups] = useState<TagGroupSummary[]>(initialTagGroups ?? []);

  const poll = useCallback(async () => {
    try {
      const result = await fetchProjects();
      setProjects(result.projects);
      setTagGroups(result.tagGroups);
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

  return <ProjectsTable projects={projects} tagGroups={tagGroups} />;
}
