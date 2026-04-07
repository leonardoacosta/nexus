module "cloudflare" {
  source = "../../modules/cloudflare"

  zone_id    = var.cloudflare_zone_id
  homelab_ip = var.homelab_ip
}


module "homelab_postgres" {
  source = "../../modules/homelab-postgres"

  homelab_ip = var.homelab_ip
}

# Nexus application secrets — generated once, stored in TF state.
# Do NOT set TF_VAR_nexus_encryption_key or TF_VAR_nexus_attach_secret manually.
resource "random_password" "nexus_encryption_key" {
  length  = 64
  special = false
}

resource "random_password" "nexus_attach_secret" {
  length  = 32
  special = false
}
