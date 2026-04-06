## ADDED Requirements

### Requirement: Terraform infrastructure layer for nx homelab prod deployment
The nx project SHALL have an `infra/` directory at the repo root containing a complete Terraform configuration for managing Cloudflare DNS and Tailscale ACLs for the homelab production environment. Only a `prod/` environment root exists — no `dev/` directory. State SHALL be stored in Terraform Cloud under the `priceless-dev` org, workspace `nx-prod`. A `tf.sh` wrapper script SHALL be the only interface developers need; they SHALL NOT invoke terraform directly.

#### Scenario: engineer runs `pnpm tf plan` for the first time on a new machine
- **WHEN** `infra/.secrets.env` does not exist and `pnpm tf plan` is invoked
- **THEN** `tf.sh` generates `infra/.secrets.env` with commented placeholders, auto-generates one-time secrets (`NEXUS_ENCRYPTION_KEY`, `NEXUS_ATTACH_SECRET`) via `openssl rand`, sets `chmod 600`, prints instructions to fill in API tokens, and exits 1

#### Scenario: engineer runs `pnpm tf apply` with all secrets populated
- **WHEN** `infra/.secrets.env` exists with all `TF_VAR_*` tokens filled in
- **THEN** Terraform applies cloudflare and tailscale module resources, then writes `infra/.tf-outputs.env` with all output values prefixed `TF_OUT_`, sets `chmod 600`

#### Scenario: `terraform import` of existing Cloudflare DNS record
- **WHEN** engineer runs `pnpm tf init` then imports an existing `nexus.leonardoacosta.dev` A-record
- **THEN** state reflects the existing record and `pnpm tf plan` shows no changes to that resource

### Requirement: cloudflare module manages internal DNS A-record
The `infra/modules/cloudflare/` module SHALL declare a Cloudflare DNS A-record for `nexus.leonardoacosta.dev` pointing to the homelab's Tailscale IP. The record SHALL have `proxied = false` (internal tunnel; Cloudflare proxy not used for homelab-internal access).

#### Scenario: DNS record points to Tailscale IP
- **WHEN** `pnpm tf apply` completes successfully
- **THEN** the Cloudflare DNS A-record for `nexus.leonardoacosta.dev` resolves to the value of `var.homelab_ip`

#### Scenario: Cloudflare proxy is disabled
- **WHEN** the cloudflare module resource is inspected in Terraform state
- **THEN** `proxied` is `false`

### Requirement: tailscale module manages ACL entry for nexus ports
The `infra/modules/tailscale/` module SHALL declare a Tailscale ACL entry granting `tag:homelab` access to ports 7400 (agent API) and 3100 (dashboard).

#### Scenario: tailscale ACL allows agent API port
- **WHEN** `pnpm tf apply` completes
- **THEN** a Tailscale ACL rule exists permitting `tag:homelab` to reach port 7400

#### Scenario: tailscale ACL allows dashboard port
- **WHEN** `pnpm tf apply` completes
- **THEN** the same Tailscale ACL rule covers port 3100

### Requirement: outputs.tf surfaces secrets consumed by the deploy hook
`infra/environments/prod/outputs.tf` SHALL declare `nexus_encryption_key`, `nexus_attach_secret`, `postgres_url` (all sensitive), and `homelab_ip` (non-sensitive) as outputs. After `apply`, `tf.sh` SHALL write these as `TF_OUT_*` exports to `infra/.tf-outputs.env`.

#### Scenario: `.tf-outputs.env` exists after apply
- **WHEN** `pnpm tf apply` completes with no errors
- **THEN** `infra/.tf-outputs.env` exists, is `chmod 600`, and contains `export TF_OUT_NEXUS_ENCRYPTION_KEY=...`, `export TF_OUT_NEXUS_ATTACH_SECRET=...`, `export TF_OUT_POSTGRES_URL=...`, `export TF_OUT_HOMELAB_IP=...`

#### Scenario: sensitive outputs are not printed to stdout
- **WHEN** `pnpm tf output` is called
- **THEN** sensitive values are masked with `(sensitive value)` by Terraform

## MODIFIED Requirements

### Requirement: root package.json exposes `pnpm tf *` interface
Root `package.json` SHALL include a `"tf"` script pointing to `./infra/scripts/tf.sh` so engineers can run all Terraform operations from any directory in the monorepo without cd-ing into `infra/`.

#### Scenario: `pnpm tf plan` from repo root
- **WHEN** `pnpm tf plan` is run from the repo root
- **THEN** `tf.sh` resolves `infra/environments/prod/` as the working directory and runs `terraform plan -out=prod.tfplan`

#### Scenario: `pnpm tf plan` from a nested package directory
- **WHEN** `pnpm tf plan` is run from `apps/agent/`
- **THEN** the same `prod.tfplan` is produced in `infra/environments/prod/`

### Requirement: deploy hooks source `.tf-outputs.env` before service restart
`deploy/hooks/pre-push` and `deploy/hooks/post-merge` SHALL source `infra/.tf-outputs.env` when it exists and call `systemctl --user set-environment` to inject `POSTGRES_URL`, `NEXUS_ENCRYPTION_KEY`, and `NEXUS_ATTACH_SECRET` into the systemd session before restarting `nexus-agent`. If the file is absent the hook SHALL print a warning and continue non-blocking.

#### Scenario: hook injects env vars when `.tf-outputs.env` is present
- **WHEN** `git push origin main` triggers `pre-push` and `infra/.tf-outputs.env` exists
- **THEN** the hook calls `systemctl --user set-environment POSTGRES_URL=... NEXUS_ENCRYPTION_KEY=... NEXUS_ATTACH_SECRET=...` and then restarts `nexus-agent`

#### Scenario: hook continues without abort when `.tf-outputs.env` is absent
- **WHEN** `git push origin main` triggers `pre-push` and `infra/.tf-outputs.env` does not exist
- **THEN** the hook prints `WARNING: infra/.tf-outputs.env not found — run: pnpm tf apply` and does NOT exit non-zero
