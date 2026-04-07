output "acl_id" {
  description = "ID of the Tailscale ACL resource"
  value       = tailscale_acl.nexus_homelab.id
}
