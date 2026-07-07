# capture-intake Delta

## ADDED Requirements

### Requirement: The agent SHALL proxy capture posts with loud-failure write posture

nexus-agent SHALL serve `POST /capture`, forwarding the JSON body to the mx
gateway behind the standard auth middleware, propagating gateway 4xx/5xx
verbatim and mapping timeouts to 504 — never returning a fabricated success.

#### Scenario: Capture round-trips
- **WHEN** an authed `POST /capture {"title":"..."}` hits the agent
- **THEN** the gateway response (created id) returns unmodified

#### Scenario: Gateway down fails loudly
- **GIVEN** the mx gateway is unreachable
- **WHEN** a capture is posted
- **THEN** the agent returns 504 and no success indication

### Requirement: A documented share-sheet Shortcut SHALL be the pilot capture surface

The repo SHALL carry a Shortcut recipe (docs/capture-shortcut.md) covering
share-sheet and manual invocation, title/url mapping, Tailscale agent URL +
auth header, and success/failure banner behavior — sufficient for rebuilding
the Shortcut from scratch on a new phone.

#### Scenario: Recipe is complete
- **WHEN** the Shortcut is rebuilt on a fresh device following only the doc
- **THEN** a shared page captures successfully and a stopped agent produces the documented failure banner
