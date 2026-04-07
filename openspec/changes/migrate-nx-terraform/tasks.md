# Implementation Tasks

<!-- beads:epic:nx-94to -->

## Infra Scaffold Batch

- [ ] [1.1] [P-1] Create TF Cloud workspace `nx-prod` at app.terraform.io (CLI-driven, Local execution mode) [owner:user] → REQUIRES USER ACTION: Create TF Cloud workspace manually at app.terraform.io (org: priceless-dev, workspace: nx-prod) [beads:nx-67dz]
- [x] [1.2] [P-1] Scaffold `infra/environments/prod/` and `infra/modules/{cloudflare,tailscale}/` directories [owner:infra-engineer] [beads:nx-f80y]
- [x] [1.3] [P-2] Write `infra/environments/prod/providers.tf` (TF Cloud backend `nx-prod`, cloudflare ~> 5.0, tailscale ~> 0.17) [owner:infra-engineer] [beads:nx-5gqt]
- [x] [1.4] [P-2] Write `infra/environments/prod/variables.tf` + `terraform.tfvars` (non-sensitive defaults: zone name, homelab_ip placeholder) [owner:infra-engineer] [beads:nx-v25m]
- [x] [1.5] [P-2] Write `infra/modules/cloudflare/` (A-record for `nexus.leonardoacosta.dev` → homelab Tailscale IP, `proxied = false`) [owner:infra-engineer] [beads:nx-74w6]
- [x] [1.6] [P-2] Write `infra/modules/tailscale/` (ACL entry: `tag:homelab` → ports 7400 + 3100) [owner:infra-engineer] [beads:nx-50oy]
- [x] [1.7] [P-2] Write `infra/environments/prod/main.tf` (module instantiations for cloudflare + tailscale) [owner:infra-engineer] [beads:nx-kqia]
- [x] [1.8] [P-2] Write `infra/environments/prod/outputs.tf` (`nexus_encryption_key`, `nexus_attach_secret`, `postgres_url`, `homelab_ip`) [owner:infra-engineer] [beads:nx-hw7b]

## tf.sh + pnpm Integration Batch

- [x] [2.1] [P-1] Write `infra/scripts/tf.sh` (secrets bootstrap, no vercel env pull, post-apply `.tf-outputs.env` write, all standard commands) [owner:infra-engineer] [beads:nx-r4f6]
- [x] [2.2] [P-2] Add `"tf": "./infra/scripts/tf.sh"` to root `package.json` scripts [owner:infra-engineer] [beads:nx-23b5]
- [x] [2.3] [P-2] Add `infra/.secrets.env`, `infra/.tf-outputs.env`, `infra/**/.terraform/` to `.gitignore` [owner:infra-engineer] [beads:nx-z0ur]

## Deploy Hook Integration Batch

- [x] [3.1] [P-1] Extend `deploy/hooks/pre-push` to source `infra/.tf-outputs.env` (if present) and call `systemctl --user set-environment` for `POSTGRES_URL`, `NEXUS_ENCRYPTION_KEY`, `NEXUS_ATTACH_SECRET` before service restart [owner:infra-engineer] [beads:nx-8ilr]
- [x] [3.2] [P-2] Apply same `.tf-outputs.env` sourcing extension to `deploy/hooks/post-merge` [owner:infra-engineer] [beads:nx-0ake]

## First Apply + Validation Batch

- [ ] [4.1] [P-1] Run `pnpm tf init` — verify TF Cloud workspace connects and providers download [owner:user] → REQUIRES USER ACTION: Fill in infra/.secrets.env tokens then run `pnpm tf init` [beads:nx-t21b]
- [ ] [4.2] [P-1] Import existing Cloudflare DNS record: `terraform import module.cloudflare.cloudflare_dns_record.nexus_homelab <zone_id>/<record_id>` [owner:user] → REQUIRES USER ACTION: Run `pnpm tf init` first, then `terraform -chdir=infra/environments/prod import module.cloudflare.cloudflare_dns_record.nexus_homelab <zone_id>/<record_id>` [beads:nx-ui58]
- [ ] [4.3] [P-2] Run `pnpm tf plan` — verify no unintended changes shown [owner:user] [beads:nx-3u5y]
- [ ] [4.4] [P-2] Run `pnpm tf apply` — verify `.tf-outputs.env` written and contains all four outputs [owner:user] [beads:nx-8p42]
- [ ] [4.5] [P-3] Push to main and verify hook sources `.tf-outputs.env` and restarts agent with injected env vars [owner:user] [beads:nx-xyns]
