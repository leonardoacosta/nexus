# Proposal: Migrate nx to Terraform

## Change ID
`migrate-nx-terraform`

## Summary
Add a Terraform infrastructure layer (`infra/`) to the nx project that manages Cloudflare DNS and Tailscale ACLs for the homelab deployment, with Terraform Cloud as the state backend and terraform outputs wired into the existing git-hook deploy path.

## Context
- Extends: `deploy/hooks/pre-push`, `deploy/hooks/post-merge`, `deploy/install.sh`, `deploy/traefik/nexus-dashboard.yml`
- Related: archived spec `deploy-dashboard-homelab` — first deployment spec, established Traefik + Cloudflare DNS-01 + Tailscale topology

## Motivation
The nx homelab deployment (Docker Compose + Traefik + Cloudflare internal tunnel + Tailscale mesh) is currently managed manually. DNS records, Tailscale ACL entries, and secret values (encryption key, attach secret) are not declared in code and can drift or be lost. There is also no deploy script — the git-hook builds and installs the agent, but does not orchestrate Docker Compose. This spec adds a Terraform layer that owns DNS and secrets linkage, writes outputs to `.tf-outputs.env`, and wires that file into an expanded deploy hook so the entire prod workflow is reproducible from code.

## Requirements

### Req-1: Terraform directory scaffold (prod only)
`infra/` at the repo root (not under `packages/`) follows the self-hosted layout from the migration guide. Only a `prod/` environment exists — no `dev/` directory. Structure:

```
infra/
├── environments/
│   └── prod/
│       ├── main.tf
│       ├── providers.tf
│       ├── variables.tf
│       ├── outputs.tf
│       └── terraform.tfvars
├── modules/
│   ├── cloudflare/
│   └── tailscale/
└── scripts/
    └── tf.sh
```

### Req-2: providers.tf — Terraform Cloud backend + cloudflare/tailscale providers
`infra/environments/prod/providers.tf` declares:
- `required_version = ">= 1.5"`
- `cloudflare/cloudflare ~> 5.0`
- `tailscale/tailscale ~> 0.17`
- Terraform Cloud backend: org `priceless-dev`, workspace `nx-prod`

### Req-3: cloudflare module — internal DNS record
`infra/modules/cloudflare/` manages the Cloudflare DNS A-record for `nexus.leonardoacosta.dev` pointing to the homelab's Tailscale IP. Record is `proxied = false` (internal tunnel; no public Cloudflare proxy needed). Variables: `zone_id`, `cloudflare_api_token`, `homelab_ip`.

### Req-4: tailscale module — ACL entry
`infra/modules/tailscale/` manages a Tailscale ACL entry granting the homelab tag (`tag:homelab`) access to the nexus service port (7400 for agent API, 3100 for dashboard). Variables: `tailscale_api_key`, `tailscale_tailnet`.

### Req-5: variables.tf + terraform.tfvars
`infra/environments/prod/variables.tf` declares all input variables with `sensitive = true` for tokens/secrets and `default = ""` (sourced from `TF_VAR_*` env vars). `terraform.tfvars` commits non-sensitive defaults: `homelab_ip` placeholder, DNS zone name.

### Req-6: outputs.tf — secrets for deploy hook
`infra/environments/prod/outputs.tf` surfaces the values that the deploy hook needs at runtime:
- `nexus_encryption_key` (var pass-through, sensitive)
- `nexus_attach_secret` (var pass-through, sensitive)
- `postgres_url` (var pass-through, sensitive)
- `homelab_ip` (non-sensitive)

These are written to `infra/.tf-outputs.env` by `tf.sh` after every `apply`.

### Req-7: tf.sh wrapper script
`infra/scripts/tf.sh` follows the migration guide template, adapted for non-Vercel self-hosted:
- No `vercel env pull` on `init` (project has no Vercel link)
- Secrets bootstrap: generates `infra/.secrets.env` on first run with `TF_VAR_cloudflare_api_token`, `TF_VAR_tailscale_api_key`, `TF_VAR_tailscale_tailnet`, `TF_VAR_nexus_encryption_key` (openssl generated once), `TF_VAR_nexus_attach_secret` (openssl generated once), `TF_VAR_postgres_url`
- After `apply`: writes `infra/.tf-outputs.env` via `terraform output -json | jq -r`
- Commands: `init`, `plan`, `apply`, `destroy`, `output`, `fmt`, `validate`
- `chmod 600` on both secrets files

### Req-8: pnpm tf * from root package.json
Root `package.json` gains a `"tf"` script pointing to `./infra/scripts/tf.sh`. Developers run `pnpm tf plan`, `pnpm tf apply`, etc. — never `cd infra/`.

### Req-9: Wire .tf-outputs.env into the deploy hook
The existing `deploy/hooks/pre-push` (and `post-merge`) is extended to source `infra/.tf-outputs.env` when it exists and inject the values as environment variables before the service restart. If the file is absent, the hook prints a warning (`Run: pnpm tf apply`) but does NOT abort — the service may already have the env vars from a prior install. The hook exports `POSTGRES_URL`, `NEXUS_ENCRYPTION_KEY`, `NEXUS_ATTACH_SECRET` from `TF_OUT_*` vars into the systemd unit via `systemctl --user set-environment` before restarting.

### Req-10: .gitignore entries
`infra/.secrets.env` and `infra/.tf-outputs.env` are added to `.gitignore`. The `infra/environments/prod/.terraform/` directory is also excluded.

## Scope
- **IN**: `infra/` directory structure, `providers.tf`, `variables.tf`, `terraform.tfvars`, `outputs.tf`, `main.tf`, `modules/cloudflare/`, `modules/tailscale/`, `infra/scripts/tf.sh`, root `package.json` `tf` script, `deploy/hooks/pre-push` + `post-merge` extended to source `.tf-outputs.env`, `.gitignore` additions
- **OUT**: Terraform Cloud workspace creation (user task), `terraform import` of existing DNS records (user task after scaffold), Docker Compose file changes, Traefik configuration changes, TLS certificate management, actual secret value population (user fills `.secrets.env`), any application code changes

## Impact
| Area | Change |
|------|--------|
| `infra/` | New directory — entire Terraform layer |
| `package.json` | Add `"tf"` script |
| `deploy/hooks/pre-push` | Source `.tf-outputs.env`, inject env vars before service restart |
| `deploy/hooks/post-merge` | Same extension as pre-push |
| `.gitignore` | Add `infra/.secrets.env`, `infra/.tf-outputs.env`, `infra/**/.terraform/` |

## Risks
| Risk | Mitigation |
|------|-----------|
| Existing DNS record imported incorrectly causes outage | `terraform import` is a user task done in dry-run first; `plan` shows diff before any apply |
| `.tf-outputs.env` absent on new machine breaks hook | Hook warns and continues — service still works if env already present from prior install |
| Tailscale API key rotation invalidates provider auth | `TF_VAR_tailscale_api_key` in `.secrets.env` updated manually; `pnpm tf apply` re-syncs |
| openssl-generated secrets differ between machines | Generated ONCE into `.secrets.env` and committed to `.tf-outputs.env` via apply; never regenerated |
