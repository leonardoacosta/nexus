export const dynamic = "force-dynamic";

import { fetchSessions } from "./actions/sessions";
import { SessionListPoller } from "@/components/SessionListPoller";

export default async function Home() {
  const { sessions, agentCount } = await fetchSessions();

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
        Dashboard
      </h1>
      <SessionListPoller
        initialSessions={sessions}
        initialAgentCount={agentCount}
      />
    </div>
  );
}
