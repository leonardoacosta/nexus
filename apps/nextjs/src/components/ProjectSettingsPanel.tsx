"use client";

import { useState, useTransition, useCallback, useRef } from "react";
import type { CanonicalProject } from "@nexus/core";
import { updateProject } from "@/app/actions/projects";

interface ProjectSettingsPanelProps {
  project: CanonicalProject;
}

export function ProjectSettingsPanel({ project }: ProjectSettingsPanelProps) {
  // --- State ---
  const [description, setDescription] = useState(project.description ?? "");
  const [tags, setTags] = useState<string[]>(project.tags ?? []);
  const [tagInput, setTagInput] = useState("");
  const [saveStatus, setSaveStatus] = useState<"idle" | "success" | "error">("idle");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();
  const clearTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // --- Handlers ---
  const addTag = useCallback((raw: string) => {
    const trimmed = raw.trim().toLowerCase();
    if (!trimmed) return;
    setTags((prev) => {
      if (prev.includes(trimmed)) return prev;
      return [...prev, trimmed];
    });
  }, []);

  const handleTagKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>) => {
      if (e.key === "Enter" || e.key === ",") {
        e.preventDefault();
        addTag(tagInput);
        setTagInput("");
      }
    },
    [tagInput, addTag],
  );

  const handleTagInputChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const value = e.target.value;
      // If the user types a comma, commit the preceding text immediately
      if (value.endsWith(",")) {
        addTag(value.slice(0, -1));
        setTagInput("");
      } else {
        setTagInput(value);
      }
    },
    [addTag],
  );

  const removeTag = useCallback((tag: string) => {
    setTags((prev) => prev.filter((t) => t !== tag));
  }, []);

  const handleSave = useCallback(() => {
    setErrorMessage(null);
    setSaveStatus("idle");

    startTransition(async () => {
      try {
        await updateProject(project.id, { tags, description, name: project.name });

        setSaveStatus("success");
        if (clearTimerRef.current) clearTimeout(clearTimerRef.current);
        clearTimerRef.current = setTimeout(() => setSaveStatus("idle"), 2000);
      } catch (err) {
        setErrorMessage(err instanceof Error ? err.message : "Failed to save");
        setSaveStatus("error");
      }
    });
  }, [project.id, tags, description]);

  // --- Shared styles ---
  const labelStyle: React.CSSProperties = {
    display: "block",
    fontSize: "var(--font-size-xs)",
    color: "var(--color-fg-muted)",
    marginBottom: "var(--space-1)",
    textTransform: "uppercase",
    letterSpacing: "var(--tracking-wide)",
    fontWeight: "var(--font-weight-medium)",
  };

  const sectionStyle: React.CSSProperties = {
    display: "flex",
    flexDirection: "column",
    gap: "var(--space-1)",
  };

  const inputStyle: React.CSSProperties = {
    width: "100%",
    padding: "var(--space-2)",
    fontSize: "var(--font-size-sm)",
    background: "var(--color-surface-raised)",
    border: "1px solid var(--color-border)",
    borderRadius: "var(--radius-md)",
    color: "var(--color-fg)",
    outline: "none",
    boxSizing: "border-box",
  };

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        gap: "var(--space-6)",
      }}
    >
      {/* Read-only: name */}
      <div style={sectionStyle}>
        <span style={labelStyle}>Project Name</span>
        <span
          style={{
            fontSize: "var(--font-size-base)",
            fontFamily: "var(--font-mono)",
            color: "var(--color-fg)",
            padding: "var(--space-2)",
            background: "var(--color-surface-raised)",
            border: "1px solid var(--color-border)",
            borderRadius: "var(--radius-md)",
          }}
        >
          {project.name}
        </span>
      </div>

      {/* Read-only: per-agent presence badges */}
      {project.locations.length > 0 && (
        <div style={sectionStyle}>
          <span style={labelStyle}>Agents</span>
          <div
            style={{
              display: "flex",
              flexDirection: "column",
              gap: "var(--space-2)",
              padding: "var(--space-2)",
              background: "var(--color-surface-raised)",
              border: "1px solid var(--color-border)",
              borderRadius: "var(--radius-md)",
            }}
          >
            {project.locations
              .slice()
              .sort((a, b) => a.priority - b.priority)
              .map((loc) => {
                const isActive = loc.status === "active";
                const isMissing = loc.status === "missing";
                return (
                  <div
                    key={loc.agentId}
                    title={loc.path}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: "var(--space-2)",
                      opacity: isMissing ? 0.5 : 1,
                    }}
                  >
                    {/* Presence dot: ● active / ○ missing */}
                    <span
                      style={{
                        width: "8px",
                        height: "8px",
                        borderRadius: "50%",
                        flexShrink: 0,
                        background: isActive
                          ? loc.isPrimary
                            ? "var(--color-success)"
                            : "var(--color-fg-muted)"
                          : "transparent",
                        border: isActive
                          ? "none"
                          : "1px solid var(--color-fg-muted)",
                        boxShadow:
                          isActive && loc.isPrimary
                            ? "0 0 6px rgba(34, 197, 94, 0.6)"
                            : "none",
                      }}
                    />
                    <span
                      style={{
                        fontSize: "var(--font-size-xs)",
                        fontFamily: "var(--font-mono)",
                        color: isActive
                          ? "var(--color-fg-dim)"
                          : "var(--color-fg-muted)",
                        textDecoration: isMissing ? "line-through" : "none",
                        flex: 1,
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                      }}
                    >
                      {loc.agentName}
                      {loc.isPrimary && (
                        <span
                          style={{
                            marginLeft: "var(--space-1)",
                            fontSize: "var(--font-size-xs)",
                            color: "var(--color-fg-ghost)",
                            fontFamily: "var(--font-sans)",
                          }}
                        >
                          (primary)
                        </span>
                      )}
                    </span>
                    <span
                      style={{
                        fontSize: "var(--font-size-xs)",
                        color: "var(--color-fg-ghost)",
                        fontFamily: "var(--font-mono)",
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                        maxWidth: "200px",
                      }}
                      title={loc.path}
                    >
                      {loc.path}
                    </span>
                  </div>
                );
              })}
          </div>
        </div>
      )}

      {/* Editable: description */}
      <div style={sectionStyle}>
        <label htmlFor="project-description" style={labelStyle}>
          Description
        </label>
        <textarea
          id="project-description"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          rows={3}
          placeholder="Short description of this project…"
          style={{
            ...inputStyle,
            resize: "vertical",
            fontFamily: "inherit",
          }}
        />
      </div>

      {/* Editable: tags */}
      <div style={sectionStyle}>
        <span style={labelStyle}>Tags</span>

        {/* Chip list */}
        {tags.length > 0 && (
          <div
            style={{
              display: "flex",
              flexWrap: "wrap",
              gap: "var(--space-1_5)",
              marginBottom: "var(--space-1)",
            }}
          >
            {tags.map((tag) => (
              <span
                key={tag}
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  gap: "var(--space-1)",
                  padding: "var(--space-0_5) var(--space-2)",
                  fontSize: "var(--font-size-xs)",
                  fontFamily: "var(--font-mono)",
                  color: "var(--color-fg-dim)",
                  background: "var(--color-surface-raised)",
                  border: "1px solid var(--color-border)",
                  borderRadius: "9999px",
                }}
              >
                {tag}
                <button
                  type="button"
                  aria-label={`Remove tag ${tag}`}
                  onClick={() => removeTag(tag)}
                  style={{
                    display: "inline-flex",
                    alignItems: "center",
                    justifyContent: "center",
                    background: "transparent",
                    border: "none",
                    cursor: "pointer",
                    color: "var(--color-fg-muted)",
                    fontSize: "var(--font-size-xs)",
                    padding: 0,
                    lineHeight: 1,
                  }}
                >
                  &times;
                </button>
              </span>
            ))}
          </div>
        )}

        {/* Tag input */}
        <input
          type="text"
          value={tagInput}
          onChange={handleTagInputChange}
          onKeyDown={handleTagKeyDown}
          placeholder="Add tag — press Enter or comma to confirm"
          style={inputStyle}
        />
        <span
          style={{
            fontSize: "var(--font-size-xs)",
            color: "var(--color-fg-muted)",
          }}
        >
          Tags are stored lowercase. Duplicates are ignored.
        </span>
      </div>

      {/* Save row */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "flex-end",
          gap: "var(--space-3)",
        }}
      >
        {saveStatus === "success" && (
          <span
            style={{
              fontSize: "var(--font-size-sm)",
              color: "var(--color-success)",
            }}
          >
            Saved
          </span>
        )}
        {saveStatus === "error" && errorMessage && (
          <span
            style={{
              fontSize: "var(--font-size-sm)",
              color: "var(--color-error)",
            }}
          >
            {errorMessage}
          </span>
        )}
        <button
          type="button"
          onClick={handleSave}
          disabled={isPending}
          style={{
            padding: "var(--space-2) var(--space-6)",
            fontSize: "var(--font-size-sm)",
            fontWeight: "var(--font-weight-medium)",
            color: "var(--color-primary-fg)",
            background: isPending
              ? "var(--color-surface-raised)"
              : "var(--color-primary)",
            border: isPending
              ? "1px solid var(--color-border)"
              : "1px solid var(--color-primary)",
            borderRadius: "var(--radius-md)",
            cursor: isPending ? "not-allowed" : "pointer",
            transition: "opacity var(--transition-fast)",
          }}
        >
          {isPending ? "Saving\u2026" : "Save"}
        </button>
      </div>
    </div>
  );
}
