# Implementation Tasks

<!-- beads:epic:nx-wb3 -->

## Deploy Batch

- [x] [1.1] [P-1] Add agents.toml parser function to 02-deploy — extract remote host+user pairs, skip self_name/localhost [beads:nx-d5q]
- [x] [1.2] [P-2] Add remote deploy fan-out loop after local deploy — SSH with 2s delay, git pull, run 02-deploy --force, backgrounded with timeout [beads:nx-pfr]
- [x] [1.3] [P-2] Add TTS notification for remote deploy results — success/failure per host via nexus-agent.sock [beads:nx-aw4]

## Test Batch

- [x] [2.1] Verify local deploy still works unchanged (02-deploy --force) [beads:nx-l62]
- [x] [2.2] Verify remote SSH fan-out connects to macbook and triggers deploy [beads:nx-qk1]
