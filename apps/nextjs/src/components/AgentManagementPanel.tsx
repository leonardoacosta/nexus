"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { saveAgentConfig } from "@/app/actions/settings";
import { Card, Badge, StatusDot } from "@nexus/ui";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface AgentSelfConfig {
  name: string;
  host: string;
  port: number;
  role: string;
  projects_dir: string;
}

interface AgentManagementPanelProps {
  initialAgents: (AgentSelfConfig | null)[];
  agentStatuses: Array<{ name: string; online: boolean; lastSeen: Date | null }>;
}

interface AddAgentForm {
  name: string;
  host: string;
  port: string;
  projects_dir: string;
}

const EMPTY_FORM: AddAgentForm = {
  name: "",
  host: "",
  port: "7400",
  projects_dir: "",
};

// ---------------------------------------------------------------------------
// Styles
// ---------------------------------------------------------------------------

const labelStyle = {
  fontSize: "var(--font-size-xs)",
  color: "var(--color-fg-muted)",
  marginBottom: "var(--space-1)",
  display: "block" as const,
};

const inputStyle = {
  width: "100%",
  padding: "var(--space-1) var(--space-2)",
  fontSize: "var(--font-size-sm)",
  background: "var(--color-surface-raised)",
  border: "1px solid var(--color-border)",
  borderRadius: "var(--radius-md)",
  color: "var(--color-fg)",
  outline: "none",
  boxSizing: "border-box" as const,
};

const thStyle = {
  textAlign: "left" as const,
  padding: "var(--space-2) var(--space-3)",
  color: "var(--color-fg-muted)",
  fontSize: "var(--font-size-xs)",
  fontWeight: "var(--font-weight-medium)" as const,
  textTransform: "uppercase" as const,
  letterSpacing: "var(--tracking-wide)",
  borderBottom: "1px solid var(--color-border)",
  whiteSpace: "nowrap" as const,
};

const tdStyle = {
  padding: "var(--space-2) var(--space-3)",
  color: "var(--color-fg)",
  fontSize: "var(--font-size-sm)",
  borderBottom: "1px solid var(--color-border)",
  verticalAlign: "middle" as const,
};

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function AgentManagementPanel({
  initialAgents,
  agentStatuses,
}: AgentManagementPanelProps) {
  const router = useRouter();
  const [form, setForm] = useState<AddAgentForm>(EMPTY_FORM);
  const [isPending, startTransition] = useTransition();

  const statusMap = new Map(agentStatuses.map((s) => [s.name, s]));

  // Only render agents that reported self-config (non-null)
  const agents = initialAgents.filter((a): a is AgentSelfConfig => a !== null);

  function handleFieldChange(field: keyof AddAgentForm, value: string) {
    setForm((prev) => ({ ...prev, [field]: value }));
  }

  function handleAdd() {
    const portNum = parseInt(form.port, 10);
    if (!form.name.trim() || !form.host.trim() || isNaN(portNum)) return;

    startTransition(async () => {
      await saveAgentConfig("add", {
        name: form.name.trim(),
        host: form.host.trim(),
        port: portNum,
        projects_dir: form.projects_dir.trim() || undefined,
      });
      setForm(EMPTY_FORM);
      router.refresh();
    });
  }

  function handleRemove(agent: AgentSelfConfig) {
    startTransition(async () => {
      await saveAgentConfig("remove", {
        name: agent.name,
        host: agent.host,
        port: agent.port,
      });
      router.refresh();
    });
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-6)" }}>
      {/* Agent Table */}
      <Card title="Configured Agents">
        {agents.length === 0 ? (
          <p
            style={{
              color: "var(--color-fg-muted)",
              fontSize: "var(--font-size-sm)",
              textAlign: "center",
              padding: "var(--space-4)",
            }}
          >
            No agents configured
          </p>
        ) : (
          <div style={{ overflowX: "auto" }}>
            <table
              style={{
                width: "100%",
                borderCollapse: "collapse",
                fontSize: "var(--font-size-sm)",
              }}
            >
              <thead>
                <tr>
                  <th style={thStyle}>Name</th>
                  <th style={thStyle}>Host</th>
                  <th style={thStyle}>Port</th>
                  <th style={thStyle}>Role</th>
                  <th style={thStyle}>Projects Dir</th>
                  <th style={thStyle}>Status</th>
                  <th style={{ ...thStyle, textAlign: "right" }}>Actions</th>
                </tr>
              </thead>
              <tbody>
                {agents.map((agent) => {
                  const status = statusMap.get(agent.name);
                  const online = status?.online ?? false;
                  return (
                    <tr key={agent.name}>
                      <td style={tdStyle}>
                        <div
                          style={{
                            display: "flex",
                            alignItems: "center",
                            gap: "var(--space-2)",
                          }}
                        >
                          <StatusDot status={online ? "active" : "ended"} />
                          <span
                            style={{
                              fontWeight: "var(--font-weight-medium)",
                              color: "var(--color-fg)",
                            }}
                          >
                            {agent.name}
                          </span>
                        </div>
                      </td>
                      <td style={{ ...tdStyle, fontFamily: "var(--font-mono)", color: "var(--color-fg-dim)" }}>
                        {agent.host}
                      </td>
                      <td style={{ ...tdStyle, fontFamily: "var(--font-mono)", color: "var(--color-fg-dim)" }}>
                        {agent.port}
                      </td>
                      <td style={{ ...tdStyle, color: "var(--color-fg-muted)" }}>
                        {agent.role}
                      </td>
                      <td
                        style={{
                          ...tdStyle,
                          fontFamily: "var(--font-mono)",
                          fontSize: "var(--font-size-xs)",
                          color: "var(--color-fg-dim)",
                          maxWidth: "200px",
                          overflow: "hidden",
                          textOverflow: "ellipsis",
                          whiteSpace: "nowrap",
                        }}
                      >
                        {agent.projects_dir || "—"}
                      </td>
                      <td style={tdStyle}>
                        <Badge variant={online ? "success" : "default"}>
                          {online ? "Online" : "Offline"}
                        </Badge>
                      </td>
                      <td style={{ ...tdStyle, textAlign: "right" }}>
                        <button
                          type="button"
                          disabled={isPending}
                          onClick={() => handleRemove(agent)}
                          style={{
                            padding: "var(--space-1) var(--space-3)",
                            fontSize: "var(--font-size-xs)",
                            fontWeight: "var(--font-weight-medium)",
                            color: "var(--color-error)",
                            background: "transparent",
                            border: "1px solid var(--color-error)",
                            borderRadius: "var(--radius-md)",
                            cursor: isPending ? "not-allowed" : "pointer",
                            opacity: isPending ? 0.5 : 1,
                            transition: "opacity var(--transition-fast)",
                          }}
                        >
                          Remove
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {/* Add Agent Form */}
      <Card title="Add Agent">
        <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-4)" }}>
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "1fr 1fr",
              gap: "var(--space-3)",
            }}
          >
            {/* Name */}
            <div>
              <label htmlFor="agent-name" style={labelStyle}>
                Name
              </label>
              <input
                id="agent-name"
                type="text"
                placeholder="my-dev-machine"
                value={form.name}
                onChange={(e) => handleFieldChange("name", e.target.value)}
                style={inputStyle}
              />
            </div>

            {/* Host */}
            <div>
              <label htmlFor="agent-host" style={labelStyle}>
                Host
              </label>
              <input
                id="agent-host"
                type="text"
                placeholder="100.x.x.x or hostname"
                value={form.host}
                onChange={(e) => handleFieldChange("host", e.target.value)}
                style={inputStyle}
              />
            </div>

            {/* Port */}
            <div>
              <label htmlFor="agent-port" style={labelStyle}>
                Port
              </label>
              <input
                id="agent-port"
                type="number"
                placeholder="7400"
                value={form.port}
                onChange={(e) => handleFieldChange("port", e.target.value)}
                style={inputStyle}
              />
            </div>

            {/* Projects Dir */}
            <div>
              <label htmlFor="agent-projects-dir" style={labelStyle}>
                Projects Dir
              </label>
              <input
                id="agent-projects-dir"
                type="text"
                placeholder="~/dev"
                value={form.projects_dir}
                onChange={(e) => handleFieldChange("projects_dir", e.target.value)}
                style={inputStyle}
              />
            </div>
          </div>

          <div style={{ display: "flex", justifyContent: "flex-end" }}>
            <button
              type="button"
              disabled={isPending || !form.name.trim() || !form.host.trim()}
              onClick={handleAdd}
              style={{
                padding: "var(--space-2) var(--space-6)",
                fontSize: "var(--font-size-sm)",
                fontWeight: "var(--font-weight-medium)",
                color: "var(--color-primary-fg)",
                background: "var(--color-primary)",
                border: "1px solid var(--color-primary)",
                borderRadius: "var(--radius-md)",
                cursor: isPending || !form.name.trim() || !form.host.trim() ? "not-allowed" : "pointer",
                opacity: isPending || !form.name.trim() || !form.host.trim() ? 0.6 : 1,
                transition: "opacity var(--transition-fast)",
              }}
            >
              {isPending ? "Saving…" : "Save"}
            </button>
          </div>
        </div>
      </Card>
    </div>
  );
}
