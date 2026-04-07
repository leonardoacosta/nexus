output "postgres_url" {
  description = "Full PostgreSQL connection URL for nexus-agent"
  value       = "postgres://nexus:${random_password.nexus_pg_password.result}@${var.homelab_ip}:${var.pg_port}/nexus"
  sensitive   = true
}

output "nexus_pg_password" {
  description = "Generated password for the nexus role (stored in TF state)"
  value       = random_password.nexus_pg_password.result
  sensitive   = true
}
