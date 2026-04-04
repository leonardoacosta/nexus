# Design: Agent Registry — DB-Backed

## agents table schema

```ts
// packages/db/src/schema/agents.ts
export const agents = pgTable("agents", {
  id: text("id").primaryKey(),          // hostname — natural key, one row per machine
  name: text("name").notNull(),          // display name (defaults to hostname)
  host: text("host").notNull(),          // IP or DNS name (Tailscale address)
  port: integer("port").notNull().default(7400),
  projectsDir: text("projects_dir").notNull().default(""),  // abs path, empty = not set
  enabled: boolean("enabled").notNull().default(true),
  lastSeen: timestamp("last_seen", { mode: "string" }),
  createdAt: timestamp("created_at", { mode: "string" }).notNull().defaultNow(),
});
```

`id = hostname` avoids duplicate rows on redeploy without needing a UUID. Each machine is uniquely
identified by hostname (omarchy, macbook-pro, etc.). Conflict resolution is `onConflictDoUpdate`.

## Agent self-registration flow

```
nexus-agent startup
  └─ openDatabase()                     // existing
  └─ upsertSelfInRegistry(db)           // NEW — runs once on startup
       ├─ hostname = os.hostname()
       ├─ projects_dir = process.env.NEXUS_PROJECTS_DIR ?? path.join(os.homedir(), 'dev')
       ├─ host = detect Tailscale IP via `tailscale ip -4` || '127.0.0.1'
       └─ db INSERT INTO agents ... ON CONFLICT (id) DO UPDATE
            SET host=.., port=.., last_seen=now()
            -- NOT projects_dir: user edits in DB take precedence
```

`projects_dir` is only written on the **first** insert (no overwrite on conflict). This preserves
dashboard edits across restarts. `host` and `last_seen` are always refreshed.

Bootstrap env var: `NEXUS_PROJECTS_DIR` is read **once** during self-registration. After the row
exists, the DB value is authoritative. The env var is removed from the service file in this spec —
its only surviving use is as a one-time bootstrap hint on first registration.

## /agent/self implementation

```ts
// apps/agent/src/routes/agent-self.ts
export async function handleGetAgentSelf(db: Db): Promise<Response> {
  const hostname = os.hostname();
  const row = await db.select().from(agents).where(eq(agents.id, hostname)).limit(1);
  if (!row[0]) return new Response(JSON.stringify({ error: "not registered" }), { status: 404 });
  return new Response(JSON.stringify(row[0]), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}
```

## /projects/discovered implementation

Strategy: 1-level scan of `projects_dir` subdirectories looking for `.git`. Cheap, fast (<5ms
for ~100 dirs). No deep recursion — users keep shallow project trees.

```ts
export async function handleGetDiscoveredProjects(db: Db): Promise<Response> {
  const agentRow = await db.select().from(agents).where(eq(agents.id, os.hostname())).limit(1);
  const projectsDir = agentRow[0]?.projectsDir || path.join(os.homedir(), "dev");

  const dirs = readdirSync(projectsDir, { withFileTypes: true })
    .filter(d => d.isDirectory() && existsSync(path.join(projectsDir, d.name, ".git")))
    .slice(0, 100);

  // Cross-reference with recent sessions from DB
  const recentSessions = await queryRecentSessions(db, 24 * 30);
  const sessionsByProject = groupBy(recentSessions, s => s.project);

  const projects = dirs.map(d => ({
    name: d.name,
    path: path.join(projectsDir, d.name),
    active_sessions: sessionsByProject[d.name]?.filter(s => s.status === "active").length ?? 0,
    total_sessions: sessionsByProject[d.name]?.length ?? 0,
  }));

  return new Response(JSON.stringify({ projects, truncated: dirs.length === 100 }), {
    status: 200, headers: { "Content-Type": "application/json" },
  });
}
```

## Dashboard get-client.ts replacement

```ts
// Instead of readFileSync(dashboard.json):
import { db } from "@nexus/db";
import { agents } from "@nexus/db";
import { eq } from "drizzle-orm";

async function getAgentConfigs(): Promise<AgentConfig[]> {
  const rows = await db.select().from(agents).where(eq(agents.enabled, true));
  if (rows.length === 0) return [{ name: "localhost", host: "127.0.0.1", port: 7400 }];
  return rows.map(r => ({ name: r.name, host: r.host, port: r.port }));
}
```

**Key difference**: `getClient()` becomes `async`. All callers of `getClient()` (server actions,
server components) already `await` so this is a zero-friction change.

The `resetClient()` pattern goes away — DB reads are always fresh, no singleton cache on the
config list itself.

## Settings CRUD

```ts
// saveAgentConfig becomes:
async function saveAgentConfig(action: "add" | "remove", agent: AgentConfig) {
  if (action === "add") {
    await db.insert(agents).values({ id: agent.name, name: agent.name, host: agent.host, port: agent.port })
      .onConflictDoUpdate({ target: agents.id, set: { host: agent.host, port: agent.port } });
  } else {
    await db.delete(agents).where(eq(agents.id, agent.name));
  }
  // No resetClient() needed
}
```

## NEXUS_PROJECTS_DIR removal rationale

The env var lived in `nexus-agent.service` but the Bun agent never called
`process.env.NEXUS_PROJECTS_DIR`. The route `/projects/discovered` didn't exist. Result:
projects page shows "No projects found" permanently.

Fix: remove from service file, bootstrap via upsert default (`$HOME/dev`), make the value
editable in the settings page. Agent reads it from its own DB row at runtime.

One-time migration concern: machines that already have the service installed won't have a DB row
until the agent restarts post-deploy. The deploy hook adds `pnpm db:migrate` before starting
the agent, and the self-registration upsert runs on startup — so the row is created on first
deploy of this spec.
