output "nexus_encryption_key" {
  description = "AES-256 encryption key for nexus session data"
  value       = var.nexus_encryption_key
  sensitive   = true
}

output "nexus_attach_secret" {
  description = "Shared secret for nexus attach authentication"
  value       = var.nexus_attach_secret
  sensitive   = true
}

output "postgres_url" {
  description = "PostgreSQL connection URL for nexus-agent"
  value       = var.postgres_url
  sensitive   = true
}

output "homelab_ip" {
  description = "Tailscale IP of the homelab machine"
  value       = var.homelab_ip
}
