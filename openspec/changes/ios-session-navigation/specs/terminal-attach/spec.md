## ADDED Requirements

### Requirement: Interact writer reclaim by most recent client

The agent SHALL grant the interactive-input writer to the most recently opened client, evicting any
prior holder (symmetric last-open-wins). When a client opens the interact WebSocket for a session
whose writer mutex is already held by a different live socket, the agent SHALL close the prior
holder with code `4009` — which the macOS dashboard and web terminal already handle by flipping to
their read-only state — and SHALL grant the writer to the new socket. The new opener SHALL NOT be
closed `4009` for contention.

Input ownership is therefore symmetric: a later attach from any device, iOS or macOS, reclaims the
writer for the same session, and the previously-typing device goes read-only. No new client UI is
required; the bumped device surfaces the takeover through its existing read-only badge.

#### Scenario: iOS reclaims the writer from macOS
- **GIVEN** the macOS dashboard holds the interact writer for a session
- **WHEN** the iOS client opens the interact WebSocket for the same session
- **THEN** the agent closes the macOS socket with `4009`, grants the writer to iOS, and the iOS keystrokes reach the PTY
- **AND** the macOS viewer flips to its existing read-only badge

#### Scenario: macOS reclaims the writer back from iOS
- **GIVEN** iOS holds the interact writer after a reclaim
- **WHEN** the macOS dashboard re-opens the interact WebSocket for the same session
- **THEN** the writer is granted back to macOS and the iOS viewer goes read-only

#### Scenario: New opener is never self-denied
- **WHEN** any client opens the interact WebSocket
- **THEN** it is granted the writer, evicting any prior holder, and is never closed `4009` for contention

### Requirement: Interact writer release on session dismissal

When the iOS session screen is dismissed (popped from the navigation stack), the client SHALL close
its interact WebSocket so the writer mutex is released and a stale socket cannot hold the writer
against the next attach. The client SHALL open the interact channel after the session output stream
is established so the writer claim does not race an unregistered stream.

#### Scenario: Writer released on pop
- **WHEN** the user pops the session screen off the navigation stack
- **THEN** the interact WebSocket is closed and the agent releases the writer mutex

#### Scenario: Evicted client flips read-only without a hang
- **WHEN** a client's interact socket is closed `4009` by an eviction
- **THEN** that client flips to read-only and does not silently drop keystrokes while appearing writable
