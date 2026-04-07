# homelab-postgres — provisions a dedicated nexus role + database
# on the shared homelab-postgres Docker container (pgvector:pg16, port 5436).
#
# Passwords are generated once by Terraform and stored in state.
# The superuser account is only used to bootstrap — nexus_agent connects
# as the "nexus" role exclusively.

resource "random_password" "nexus_pg_password" {
  length           = 32
  special          = false # avoid shell-escaping issues in connection strings
  override_special = ""
}

resource "postgresql_role" "nexus" {
  name     = "nexus"
  login    = true
  password = random_password.nexus_pg_password.result
}

resource "postgresql_database" "nexus" {
  name              = "nexus"
  owner             = postgresql_role.nexus.name
  connection_limit  = 25
  allow_connections = true

  depends_on = [postgresql_role.nexus]
}
