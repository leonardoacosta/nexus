output "dns_record_id" {
  description = "Cloudflare DNS record ID for nexus.leonardoacosta.dev"
  value       = cloudflare_dns_record.nexus_homelab.id
}

output "dns_record_hostname" {
  description = "Fully-qualified hostname for the nexus service"
  value       = cloudflare_dns_record.nexus_homelab.hostname
}
