resource "tailscale_acl" "nexus_homelab" {
  acl = jsonencode({
    acls = [
      {
        action = "accept"
        src    = ["tag:homelab"]
        dst    = ["tag:homelab:7400", "tag:homelab:3100"]
      }
    ]
  })
}
