// Live notification data — must render on each request.
export const dynamic = "force-dynamic";

import { fetchNotificationsPageData } from "../actions/notifications";
import { NotificationsClient } from "./NotificationsClient";

export default async function NotificationsPage() {
  const { settings, rows, agentReachable } = await fetchNotificationsPageData();

  return (
    <div>
      <div
        style={{
          display: "flex",
          alignItems: "baseline",
          justifyContent: "space-between",
          marginBottom: "var(--space-6)",
          gap: "var(--space-4)",
          flexWrap: "wrap",
        }}
      >
        <h1
          style={{
            fontSize: "var(--font-size-2xl)",
            fontWeight: "var(--font-weight-bold)",
            color: "var(--color-fg)",
            letterSpacing: "var(--tracking-tight)",
          }}
        >
          Notifications
        </h1>
        <span
          style={{
            fontSize: "var(--font-size-sm)",
            color: "var(--color-fg-muted)",
          }}
        >
          {rows.length} recent · live via SSE
        </span>
      </div>

      <NotificationsClient
        initialSettings={settings}
        initialRows={rows}
        agentReachable={agentReachable}
      />
    </div>
  );
}
