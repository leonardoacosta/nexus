"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import type { DiscoveredProject } from "@nexus/core";
import { Badge } from "@nexus/ui";
import { startSession } from "@/app/actions/settings";

interface ProjectCardProps {
  project: DiscoveredProject;
}

export function ProjectCard({ project }: ProjectCardProps) {
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  const handleStartSession = () => {
    setError(null);
    startTransition(async () => {
      try {
        await startSession(project.agent, project.name, project.path);
      } catch (err) {
        setError(
          err instanceof Error ? err.message : "Failed to start session",
        );
      }
    });
  };

  return (
    <div
      style={{
        background: "var(--color-surface)",
        border: "1px solid var(--color-border)",
        borderRadius: "var(--radius-lg)",
        padding: "var(--space-4)",
        transition: "border-color var(--transition-fast)",
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
        <Link
          href={`/projects/${encodeURIComponent(project.name)}`}
          style={{ textDecoration: "none", color: "inherit" }}
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
        </Link>
        <div style={{ display: "flex", gap: "var(--space-2)" }}>
          <Badge variant={project.active_sessions > 0 ? "success" : "default"}>
            {project.active_sessions} active
          </Badge>
          <Badge>{project.total_sessions} total</Badge>
        </div>
      </div>
      <button
        type="button"
        onClick={handleStartSession}
        disabled={isPending}
        style={{
          marginTop: "var(--space-3)",
          padding: "var(--space-2) var(--space-3)",
          background: isPending
            ? "var(--color-surface-raised)"
            : "var(--color-accent)",
          color: isPending
            ? "var(--color-fg-muted)"
            : "var(--color-fg-on-accent, #fff)",
          border: "none",
          borderRadius: "var(--radius-md)",
          cursor: isPending ? "not-allowed" : "pointer",
          fontSize: "var(--font-size-sm)",
          width: "100%",
        }}
      >
        {isPending ? "Starting\u2026" : "Start Session"}
      </button>
      {error && (
        <p
          style={{
            color: "var(--color-error)",
            fontSize: "var(--font-size-xs)",
            marginTop: "var(--space-1)",
            marginBottom: 0,
          }}
        >
          {error}
        </p>
      )}
    </div>
  );
}
