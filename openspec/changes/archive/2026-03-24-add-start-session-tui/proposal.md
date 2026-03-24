## Summary

Implement Start Session from TUI (PRD T13). Press `n` from dashboard to open a "New Session" dialog that selects an agent, enters project code and cwd, then invokes StartSession RPC. The new session appears in the dashboard within 2 seconds.

## Motivation

Currently, starting a new managed session requires SSH-ing into the target machine and running claude manually. The TUI should be the single control plane for all session operations.

depends on: add-command-palette

## Approach

1. Build modal dialog widget: agent selector (from connected agents list), project code input, cwd input
2. Use agent's project registry (ListProjects RPC) for tab-completion of project codes and cwds
3. On submit: call StartSession RPC on selected agent
4. On success: session appears in dashboard, auto-navigate to it
5. On error: show error in dialog (agent unreachable, invalid project, etc.)

## Files Modified

- `crates/nexus-tui/src/app.rs` — add NewSessionDialog state, `n` key handler
- `crates/nexus-tui/src/screens/dashboard.rs` — render new session dialog modal
- `crates/nexus-tui/src/client.rs` — add start_session() client method
- `proto/nexus.proto` — may need StartSessionRequest additions if tab-complete needs project list
