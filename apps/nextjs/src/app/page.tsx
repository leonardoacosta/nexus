export const dynamic = "force-dynamic";

import { fetchSessions } from "./actions/sessions";
import { SessionListPoller } from "@/components/SessionListPoller";

export default async function Home() {
  // withFingerprint: only return rows backed by a real claude process
  // (pid/tmuxTarget/ccSessionId/cwd populated). Excludes the legacy
  // telemetry-stub rows the cleanup migration ended. See
  // openspec/changes/fix-agent-cc-session-tracking/specs/session-persistence/spec.md
  const { sessions, agentCount, onlineAgentCount } = await fetchSessions({
    withFingerprint: true,
  });

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
        initialOnlineAgentCount={onlineAgentCount}
      />
    </div>
  );
}
