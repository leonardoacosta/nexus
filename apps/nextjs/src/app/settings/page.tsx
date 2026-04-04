import { fetchAgentStatuses, fetchAgentConfigs } from "../actions/settings";
import { getClient } from "@/lib/get-client";
import { AgentStatusList } from "@/components/AgentStatusList";
import { SettingsForm } from "@/components/SettingsForm";
import { AgentManagementPanel } from "@/components/AgentManagementPanel";
import { CommandsEditorPanel } from "@/components/CommandsEditorPanel";

export default async function SettingsPage() {
  const { agentStatuses } = await fetchAgentStatuses();
  const agentConfigs = await fetchAgentConfigs();

  // Fetch commands from each online agent
  const client = getClient();
  const commandsData = await Promise.all(
    agentStatuses.map(async (agent) => {
      if (!agent.online) {
        return { agentName: agent.name, online: false, commands: null };
      }
      const result = await client.fetchAgentCommands(agent.name);
      return {
        agentName: agent.name,
        online: true,
        commands: result?.commands ?? null,
      };
    }),
  );

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

      {/* Agent Management — full width section */}
      <section style={{ marginBottom: "var(--space-8)" }}>
        <h2
          style={{
            fontSize: "var(--font-size-lg)",
            fontWeight: "var(--font-weight-semibold)",
            color: "var(--color-fg)",
            marginBottom: "var(--space-4)",
          }}
        >
          Agent Management
        </h2>
        <AgentManagementPanel
          initialAgents={agentConfigs}
          agentStatuses={agentStatuses}
        />
      </section>

      {/* Commands Browser — full width section */}
      <section style={{ marginBottom: "var(--space-8)" }}>
        <h2
          style={{
            fontSize: "var(--font-size-lg)",
            fontWeight: "var(--font-weight-semibold)",
            color: "var(--color-fg)",
            marginBottom: "var(--space-4)",
          }}
        >
          Commands
        </h2>
        <CommandsEditorPanel initialData={commandsData} />
      </section>

      {/* Existing 2-col layout for AgentStatusList + SettingsForm */}
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "1fr 1fr",
          gap: "var(--space-6)",
          alignItems: "start",
        }}
      >
        <section>
          <h2
            style={{
              fontSize: "var(--font-size-lg)",
              fontWeight: "var(--font-weight-semibold)",
              color: "var(--color-fg)",
              marginBottom: "var(--space-4)",
            }}
          >
            Agents Status
          </h2>
          <AgentStatusList agents={agentStatuses} />
        </section>
        <div>
          <SettingsForm />
        </div>
      </div>
    </div>
  );
}
