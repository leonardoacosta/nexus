import { fetchAgentStatuses } from "../actions/settings";
import { AgentStatusList } from "@/components/AgentStatusList";
import { SettingsForm } from "@/components/SettingsForm";

export default async function SettingsPage() {
  const { agentStatuses } = await fetchAgentStatuses();

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
        Settings
      </h1>

      <div
        style={{
          display: "grid",
          gridTemplateColumns: "1fr 1fr",
          gap: "var(--space-6)",
          alignItems: "start",
        }}
      >
        {/* Left column: Agent status + Form */}
        <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-6)" }}>
          <section>
            <h2
              style={{
                fontSize: "var(--font-size-lg)",
                fontWeight: "var(--font-weight-semibold)",
                color: "var(--color-fg)",
                marginBottom: "var(--space-4)",
              }}
            >
              Agents
            </h2>
            <AgentStatusList agents={agentStatuses} />
          </section>
        </div>

        {/* Right column: Settings form */}
        <div>
          <SettingsForm />
        </div>
      </div>
    </div>
  );
}
