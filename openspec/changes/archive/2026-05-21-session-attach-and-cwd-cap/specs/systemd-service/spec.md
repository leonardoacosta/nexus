# systemd-service Specification Delta

## ADDED Requirements

### Requirement: nexus-agent.service grants CAP_SYS_PTRACE ambient capability

The `deploy/nexus-agent.service` systemd unit SHALL declare
`AmbientCapabilities=CAP_SYS_PTRACE` so the running agent process can
read `/proc/<pid>/cwd` symlinks for same-user processes regardless of
parent-ancestor relationship. This restores cwd resolution under
kernel.yama.ptrace_scope=1 hardening.

#### Scenario: agent reads cwd from non-descendant CC process

- **GIVEN** a Claude Code process is running on the homelab as the
  same user as nexus-agent.service, started from an ssh shell (NOT
  a descendant of nexus-agent.service)
- **WHEN** the process-watcher invokes `readlinkSync("/proc/<pid>/cwd")`
- **THEN** the call returns the cwd path successfully
- **AND** does NOT throw EACCES

#### Scenario: ptrace_scope kernel hardening remains intact for other processes

- **GIVEN** kernel.yama.ptrace_scope=1 is set system-wide
- **WHEN** any process OTHER THAN the granted-capability nexus-agent
  attempts to read `/proc/<pid>/cwd` for a non-ancestor target
- **THEN** the kernel still blocks it with EACCES
- **AND** only nexus-agent's ambient capability bypasses the check

#### Scenario: ambient capability persists across systemd-reload

- **WHEN** `systemctl --user daemon-reload && systemctl --user restart nexus-agent`
- **THEN** the running unit's `AmbientCapabilities=` shows `cap_sys_ptrace`
- **AND** `systemctl --user show nexus-agent -p AmbientCapabilities`
  contains the capability bit
