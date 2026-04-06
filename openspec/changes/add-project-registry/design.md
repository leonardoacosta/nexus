# Design: Add Project Registry

## Architecture Decision: Normalized Schema (2 tables)

**Decision**: `projects` (canonical identity) + `project_locations` (per-machine join) rather than a flat table with `homelab_path` / `mac_path` columns.

**Why**: A flat design hardcodes the machine topology. Adding a 3rd agent would require a schema migration. The join table naturally scales to N agents with zero schema changes — just new rows.

## Primary Agent Assignment

**Decision**: First agent to upsert the project becomes `primary_agent_id`. No admin override in v1.

**Why**: Homelab runs continuously and starts the agent at boot. It will always win the race against mac (which may be asleep). This is deterministic in practice without requiring explicit config. The `ON CONFLICT ON name DO NOTHING` for `primary_agent_id` ensures first-writer-wins semantics.

**Trade-off**: If mac somehow discovers first (e.g., homelab rebooting), mac becomes primary until manual intervention. Acceptable for v1; add a "Set as primary" UI action in a follow-on spec.

## Location Priority

- `priority = 1` for the primary agent's location
- `priority = 999` for all other agents

Rationale: Allows future multi-priority ranking (e.g., homelab=1, mac=2, laptop=3) without schema change — just update the priority value.

## Upsert Strategy

Agent-push: `/projects/discovered` endpoint upserts after each filesystem scan. The agent has filesystem authority (it just ran `fs.readdirSync`), so it's the natural write point.

Client-pull alternative was rejected: it would require the Next.js server action to know paths, adding coupling. The agent already has the expanded absolute path.

**Upsert SQL pattern:**
```sql
-- projects: first-writer-wins for primary_agent_id
INSERT INTO projects (id, name, primary_agent_id, status)
VALUES ($1, $2, $3, 'active')
ON CONFLICT (name) DO NOTHING;

-- project_locations: full upsert on (project_id, agent_id)
INSERT INTO project_locations (project_id, agent_id, path, status, active_sessions, total_sessions, last_discovered_at, priority)
VALUES ($1, $2, $3, 'active', $4, $5, NOW(), $6)
ON CONFLICT (project_id, agent_id)
DO UPDATE SET path = EXCLUDED.path, status = 'active',
              active_sessions = EXCLUDED.active_sessions,
              total_sessions = EXCLUDED.total_sessions,
              last_discovered_at = NOW();
```

**Missing-project sweep** (after upsert loop):
```sql
UPDATE project_locations
SET status = 'missing'
WHERE agent_id = $agentId
  AND project_id NOT IN ($discoveredProjectIds)
  AND status = 'active';
```

## CanonicalProject Type Relationship

```
CanonicalProject (new, from GET /api/projects)
  └── replaces WithAgent<DiscoveredProject> in fetchProjects()
  └── ProjectLocation[] — one per agent that has discovered this project

DiscoveredProject (existing, from GET /projects/discovered on agent)
  └── unchanged — still the wire format from agent endpoint
  └── agent upsert reads this and writes to DB
```

The `DiscoveredProject` type is the agent's local view. `CanonicalProject` is the DB-backed global view. They coexist: agent endpoint returns `DiscoveredProject[]`, Next.js `GET /api/projects` returns `CanonicalProject[]`.

## Session Routing Logic

```typescript
function resolveAttachAgent(project: CanonicalProject, agents: AgentStatus[]): string {
  const primaryLocation = project.locations.find(l => l.isPrimary && l.status === 'active');
  if (primaryLocation && agents.find(a => a.name === primaryLocation.agentId && a.online)) {
    return primaryLocation.agentId;
  }
  // Fallback: first active location on an online agent
  const fallback = project.locations
    .filter(l => l.status === 'active')
    .find(l => agents.find(a => a.name === l.agentId && a.online));
  return fallback?.agentId ?? project.primaryAgentId; // last resort
}
```

## Dependency Gate

This change MUST NOT be applied until `fix-project-discovery` is closed. That change:
- Stabilizes `DiscoveredProject` type (removes legacy `hasActiveSessions` field)
- Fixes dedup by git remote (may change `project.name` normalization)
- Both affect the upsert input — avoid conflicting in-flight schema assumptions
