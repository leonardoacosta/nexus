"use client";

import { useState, useTransition } from "react";
import { saveCommand } from "@/app/actions/settings";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface CommandEntry {
  name: string;
  namespace: string;
  full_name: string;
  description: string;
  tier: string;
  cost: string;
}

interface AgentCommandsData {
  agentName: string;
  online: boolean;
  commands: CommandEntry[] | null; // null = offline
}

interface CommandsEditorPanelProps {
  initialData: AgentCommandsData[];
}

interface SelectedCommand {
  agentName: string;
  fullName: string;
  content: string;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function CommandsEditorPanel({ initialData }: CommandsEditorPanelProps) {
  const [selectedCommand, setSelectedCommand] =
    useState<SelectedCommand | null>(null);
  const [editContent, setEditContent] = useState("");
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saveSuccess, setSaveSuccess] = useState(false);
  const [isPending, startTransition] = useTransition();

  // -------------------------------------------------------------------------
  // Handlers
  // -------------------------------------------------------------------------

  const handleSelectCommand = (agentName: string, fullName: string) => {
    setSelectedCommand({ agentName, fullName, content: "" });
    setEditContent(`# /${fullName}\n\n<!-- Edit this command's content -->\n`);
    setSaveError(null);
    setSaveSuccess(false);
  };

  const handleSave = () => {
    if (!selectedCommand) return;
    setSaveError(null);
    setSaveSuccess(false);
    startTransition(async () => {
      try {
        await saveCommand(
          selectedCommand.agentName,
          selectedCommand.fullName,
          editContent,
        );
        setSaveSuccess(true);
      } catch (err) {
        setSaveError(err instanceof Error ? err.message : "Save failed");
      }
    });
  };

  // -------------------------------------------------------------------------
  // Render
  // -------------------------------------------------------------------------

  return (
    <div>
      {initialData.map(({ agentName, online, commands }) => (
        <section
          key={agentName}
          style={{ marginBottom: "var(--space-6)" }}
        >
          <h3
            style={{
              fontSize: "var(--font-size-base)",
              fontWeight: "var(--font-weight-semibold)",
              marginBottom: "var(--space-3)",
            }}
          >
            {agentName}{" "}
            {!online && (
              <span
                style={{
                  color: "var(--color-fg-muted)",
                  fontSize: "var(--font-size-sm)",
                }}
              >
                — offline, commands unavailable
              </span>
            )}
          </h3>

          {online && commands && (
            <div>
              <p
                style={{
                  fontSize: "var(--font-size-xs)",
                  color: "var(--color-fg-muted)",
                  marginBottom: "var(--space-2)",
                }}
              >
                Global ({commands.length})
              </p>

              <div
                style={{
                  display: "flex",
                  flexDirection: "column",
                  gap: "var(--space-1)",
                }}
              >
                {commands.map((cmd) => (
                  <button
                    key={cmd.full_name}
                    type="button"
                    onClick={() =>
                      handleSelectCommand(agentName, cmd.full_name)
                    }
                    style={{
                      textAlign: "left",
                      padding: "var(--space-2) var(--space-3)",
                      background:
                        selectedCommand?.fullName === cmd.full_name
                          ? "var(--color-surface-raised)"
                          : "transparent",
                      border: "1px solid var(--color-border)",
                      borderRadius: "var(--radius-sm)",
                      cursor: "pointer",
                      display: "flex",
                      justifyContent: "space-between",
                      alignItems: "center",
                    }}
                  >
                    <div>
                      <span
                        style={{
                          fontWeight: "var(--font-weight-medium)",
                          fontSize: "var(--font-size-sm)",
                        }}
                      >
                        /{cmd.full_name}
                      </span>
                      {cmd.description && (
                        <span
                          style={{
                            marginLeft: "var(--space-2)",
                            color: "var(--color-fg-muted)",
                            fontSize: "var(--font-size-xs)",
                          }}
                        >
                          {cmd.description}
                        </span>
                      )}
                    </div>

                    <div style={{ display: "flex", gap: "var(--space-1)" }}>
                      <span
                        style={{
                          fontSize: "var(--font-size-xs)",
                          padding: "2px 6px",
                          background: "var(--color-surface-raised)",
                          borderRadius: "var(--radius-xs)",
                        }}
                      >
                        {cmd.tier}
                      </span>
                      <span
                        style={{
                          fontSize: "var(--font-size-xs)",
                          padding: "2px 6px",
                          background: "var(--color-surface-raised)",
                          borderRadius: "var(--radius-xs)",
                        }}
                      >
                        {cmd.cost}
                      </span>
                    </div>
                  </button>
                ))}
              </div>
            </div>
          )}
        </section>
      ))}

      {selectedCommand && (
        <div
          style={{
            marginTop: "var(--space-4)",
            border: "1px solid var(--color-border)",
            borderRadius: "var(--radius-lg)",
            padding: "var(--space-4)",
          }}
        >
          <h4
            style={{
              marginBottom: "var(--space-3)",
              fontSize: "var(--font-size-base)",
            }}
          >
            Editing: /{selectedCommand.fullName}
          </h4>

          <textarea
            value={editContent}
            onChange={(e) => setEditContent(e.target.value)}
            rows={15}
            style={{
              width: "100%",
              fontFamily: "monospace",
              fontSize: "var(--font-size-sm)",
              background: "var(--color-surface)",
              color: "var(--color-fg)",
              border: "1px solid var(--color-border)",
              borderRadius: "var(--radius-md)",
              padding: "var(--space-3)",
              resize: "vertical",
              boxSizing: "border-box",
            }}
          />

          {saveError && (
            <p
              style={{
                color: "var(--color-error)",
                fontSize: "var(--font-size-sm)",
                marginTop: "var(--space-2)",
              }}
            >
              {saveError}
            </p>
          )}

          {saveSuccess && (
            <p
              style={{
                color: "var(--color-success)",
                fontSize: "var(--font-size-sm)",
                marginTop: "var(--space-2)",
              }}
            >
              Saved successfully
            </p>
          )}

          <button
            type="button"
            onClick={handleSave}
            disabled={isPending}
            style={{
              marginTop: "var(--space-3)",
              padding: "var(--space-2) var(--space-4)",
              background: "var(--color-accent)",
              color: "#fff",
              border: "none",
              borderRadius: "var(--radius-md)",
              cursor: isPending ? "not-allowed" : "pointer",
              opacity: isPending ? 0.6 : 1,
            }}
          >
            {isPending ? "Saving\u2026" : "Save"}
          </button>
        </div>
      )}
    </div>
  );
}
