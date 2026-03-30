# Design: Project Command RPC

## Key Decision: Static vs Dynamic Command Metadata

**Choice: Static categorization table with filesystem discovery.**

The command registry scans `~/.claude/commands/` for `.md` files to discover commands, but
tier and cost categorization comes from a hardcoded lookup table in Rust. This is pragmatic
because:

1. CC command files have no standardized frontmatter schema for tier/cost metadata
2. The command set changes infrequently (weeks between additions)
3. A static table is auditable and predictable — Nova can trust the cost estimates

Unknown commands default to `ANALYSIS` tier and `MEDIUM` cost (safe middle ground).

## Key Decision: Session Lifecycle Ownership

**Choice: RunProjectCommand owns the full lifecycle via session pool.**

The caller sends `(project, command)` and gets back a stream. Nexus handles:
- Project resolution
- Session acquisition (pool hit or create)
- Prompt construction (`/<command> <args>`)
- Stream relay
- Session release

The caller never sees a session ID. This is intentional — session management is an
implementation detail that external consumers should not manage.

## Prompt Construction

Commands are invoked as literal slash command strings:

```
/audit:code
/monitor:costs
/next
/apply spec-name
```

Arguments are space-joined after the command name. The CC session interprets these as
skill invocations via its standard command routing.

## Dependency on Session Pool

`RunProjectCommand` delegates to `SessionPool::get_or_create` for session acquisition.
If the pool service is not available (feature disabled), `RunProjectCommand` falls back to
creating a temporary managed session via `StartSession`, executing, and stopping — equivalent
to the current manual workflow but automated.
