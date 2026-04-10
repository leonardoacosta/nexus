// Spec data comes from live agent — must render on each request
export const dynamic = "force-dynamic";

import { fetchWithTimeout } from "@nexus/core/fetch";
import { getAgentConfigs } from "@/lib/get-client";

interface SpecSnapshot {
  name: string;
  status: string;
  completed_tasks: number;
  total_tasks: number;
  last_modified: string | null;
}

interface BeadsSummary {
  open: number;
  closed: number;
  ready: number;
}

interface ProjectSpecStatus {
  code: string;
  name: string;
  specs: SpecSnapshot[];
  beads: BeadsSummary | null;
}

interface AllSpecsResponse {
  projects: ProjectSpecStatus[];
}

async function fetchSpecs(): Promise<AllSpecsResponse> {
  const configs = await getAgentConfigs();
  const agent = configs[0];
  if (!agent) return { projects: [] };

  try {
    const res = await fetchWithTimeout(
      `http://${agent.host}:7402/specs/all`,
      {
        headers: { "x-nexus-secret": process.env.NEXUS_ATTACH_SECRET ?? "" },
        cache: "no-store",
      },
    );
    if (!res.ok) return { projects: [] };
    return (await res.json()) as AllSpecsResponse;
  } catch {
    return { projects: [] };
  }
}

export default async function SpecsPage() {
  const { projects } = await fetchSpecs();

  const hasSpecs = projects.some((p) => p.specs.length > 0);

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
        Specs
      </h1>

      {!hasSpecs ? (
        <p style={{ color: "var(--color-fg-muted)" }}>
          No specs found across any projects.
        </p>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-6)" }}>
          {projects
            .filter((p) => p.specs.length > 0)
            .map((project) => (
              <div key={project.code}>
                <h2
                  style={{
                    fontSize: "var(--font-size-lg)",
                    fontWeight: "var(--font-weight-semibold)",
                    color: "var(--color-fg)",
                    marginBottom: "var(--space-3)",
                  }}
                >
                  {project.name}{" "}
                  <span style={{ color: "var(--color-fg-muted)", fontWeight: "normal" }}>
                    ({project.code})
                  </span>
                </h2>

                <table
                  style={{
                    width: "100%",
                    borderCollapse: "collapse",
                    fontSize: "var(--font-size-sm)",
                  }}
                >
                  <thead>
                    <tr
                      style={{
                        borderBottom: "1px solid var(--color-border)",
                        textAlign: "left",
                      }}
                    >
                      <th style={{ padding: "var(--space-2) var(--space-3)", color: "var(--color-fg-muted)" }}>
                        Name
                      </th>
                      <th style={{ padding: "var(--space-2) var(--space-3)", color: "var(--color-fg-muted)" }}>
                        Status
                      </th>
                      <th style={{ padding: "var(--space-2) var(--space-3)", color: "var(--color-fg-muted)" }}>
                        Tasks
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {project.specs.map((spec) => (
                      <tr
                        key={spec.name}
                        style={{ borderBottom: "1px solid var(--color-border)" }}
                      >
                        <td style={{ padding: "var(--space-2) var(--space-3)", color: "var(--color-fg)" }}>
                          {spec.name}
                        </td>
                        <td style={{ padding: "var(--space-2) var(--space-3)", color: "var(--color-fg-muted)" }}>
                          {spec.status}
                        </td>
                        <td style={{ padding: "var(--space-2) var(--space-3)", color: "var(--color-fg-muted)" }}>
                          {spec.completed_tasks}/{spec.total_tasks}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>

                {project.beads && (
                  <div
                    style={{
                      marginTop: "var(--space-2)",
                      fontSize: "var(--font-size-xs)",
                      color: "var(--color-fg-muted)",
                    }}
                  >
                    Beads: {project.beads.open} open, {project.beads.ready} ready
                  </div>
                )}
              </div>
            ))}
        </div>
      )}
    </div>
  );
}
