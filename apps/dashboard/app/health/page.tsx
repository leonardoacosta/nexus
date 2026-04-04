import { fetchHealth } from "../actions/health";
import { HealthPoller } from "@/components/HealthPoller";

export default async function HealthPage() {
  const { metrics, statuses } = await fetchHealth();

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
        Machine Health
      </h1>
      <HealthPoller initialMetrics={metrics} initialStatuses={statuses} />
    </div>
  );
}
