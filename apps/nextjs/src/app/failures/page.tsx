// Failure data comes from live agent — must render on each request
export const dynamic = "force-dynamic";

import { fetchWithTimeout } from "@nexus/core/fetch";
import { getAgentConfigs } from "@/lib/get-client";

interface TopError {
  summary: string;
  count: number;
  tool: string;
}

interface Trend {
  current: number;
  previous: number;
  direction: string;
}

interface FailuresResponse {
  period_days: number;
  total: number;
  by_tool: Record<string, number>;
  by_project: Record<string, number>;
  top_errors: TopError[];
  trend: Trend;
}

async function fetchFailures(): Promise<FailuresResponse | null> {
  const configs = await getAgentConfigs();
  const agent = configs[0];
  if (!agent) return null;

  try {
    const res = await fetchWithTimeout(
      `http://${agent.host}:7402/failures?days=7`,
      {
        cache: "no-store",
      },
    );
    if (!res.ok) return null;
    return (await res.json()) as FailuresResponse;
  } catch {
    return null;
  }
}

export default async function FailuresPage() {
  const data = await fetchFailures();

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
        Failures
      </h1>

      {!data || data.total === 0 ? (
        <p style={{ color: "var(--color-fg-muted)" }}>
          No failures recorded in the last 7 days.
        </p>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-6)" }}>
          {/* Summary */}
          <div
            style={{
              display: "flex",
              gap: "var(--space-6)",
              flexWrap: "wrap",
            }}
          >
            <div>
              <div
                style={{
                  fontSize: "var(--font-size-2xl)",
                  fontWeight: "var(--font-weight-bold)",
                  color: "var(--color-fg)",
                }}
              >
                {data.total}
              </div>
              <div style={{ fontSize: "var(--font-size-sm)", color: "var(--color-fg-muted)" }}>
                failures ({data.period_days}d)
              </div>
            </div>
            <div>
              <div
                style={{
                  fontSize: "var(--font-size-2xl)",
                  fontWeight: "var(--font-weight-bold)",
                  color:
                    data.trend.direction === "up"
                      ? "var(--color-danger)"
                      : data.trend.direction === "down"
                        ? "var(--color-success)"
                        : "var(--color-fg)",
                }}
              >
                {data.trend.direction === "up"
                  ? "\u2191"
                  : data.trend.direction === "down"
                    ? "\u2193"
                    : "\u2192"}
              </div>
              <div style={{ fontSize: "var(--font-size-sm)", color: "var(--color-fg-muted)" }}>
                vs prev period ({data.trend.previous})
              </div>
            </div>
          </div>

          {/* By Tool */}
          {Object.keys(data.by_tool).length > 0 && (
            <div>
              <h2
                style={{
                  fontSize: "var(--font-size-lg)",
                  fontWeight: "var(--font-weight-semibold)",
                  color: "var(--color-fg)",
                  marginBottom: "var(--space-3)",
                }}
              >
                By Tool
              </h2>
              <table
                style={{
                  width: "100%",
                  borderCollapse: "collapse",
                  fontSize: "var(--font-size-sm)",
                }}
              >
                <thead>
                  <tr style={{ borderBottom: "1px solid var(--color-border)", textAlign: "left" }}>
                    <th style={{ padding: "var(--space-2) var(--space-3)", color: "var(--color-fg-muted)" }}>
                      Tool
                    </th>
                    <th style={{ padding: "var(--space-2) var(--space-3)", color: "var(--color-fg-muted)" }}>
                      Count
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {Object.entries(data.by_tool)
                    .sort(([, a], [, b]) => b - a)
                    .map(([tool, count]) => (
                      <tr key={tool} style={{ borderBottom: "1px solid var(--color-border)" }}>
                        <td style={{ padding: "var(--space-2) var(--space-3)", color: "var(--color-fg)" }}>
                          {tool}
                        </td>
                        <td style={{ padding: "var(--space-2) var(--space-3)", color: "var(--color-fg-muted)" }}>
                          {count}
                        </td>
                      </tr>
                    ))}
                </tbody>
              </table>
            </div>
          )}

          {/* Top Errors */}
          {data.top_errors.length > 0 && (
            <div>
              <h2
                style={{
                  fontSize: "var(--font-size-lg)",
                  fontWeight: "var(--font-weight-semibold)",
                  color: "var(--color-fg)",
                  marginBottom: "var(--space-3)",
                }}
              >
                Top Errors
              </h2>
              <table
                style={{
                  width: "100%",
                  borderCollapse: "collapse",
                  fontSize: "var(--font-size-sm)",
                }}
              >
                <thead>
                  <tr style={{ borderBottom: "1px solid var(--color-border)", textAlign: "left" }}>
                    <th style={{ padding: "var(--space-2) var(--space-3)", color: "var(--color-fg-muted)" }}>
                      Error
                    </th>
                    <th style={{ padding: "var(--space-2) var(--space-3)", color: "var(--color-fg-muted)" }}>
                      Tool
                    </th>
                    <th style={{ padding: "var(--space-2) var(--space-3)", color: "var(--color-fg-muted)" }}>
                      Count
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {data.top_errors.map((err, i) => (
                    <tr key={i} style={{ borderBottom: "1px solid var(--color-border)" }}>
                      <td
                        style={{
                          padding: "var(--space-2) var(--space-3)",
                          color: "var(--color-fg)",
                          maxWidth: "400px",
                          overflow: "hidden",
                          textOverflow: "ellipsis",
                          whiteSpace: "nowrap",
                        }}
                      >
                        {err.summary}
                      </td>
                      <td style={{ padding: "var(--space-2) var(--space-3)", color: "var(--color-fg-muted)" }}>
                        {err.tool}
                      </td>
                      <td style={{ padding: "var(--space-2) var(--space-3)", color: "var(--color-fg-muted)" }}>
                        {err.count}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
