# Tasks: retire-web-dashboard-infra

- [ ] 1.1 Confirm p5-parity-audit.md is 100% checked
- [ ] 1.2 [user] systemctl --user stop nexus-dashboard
- [ ] 1.3 [user] systemctl --user disable nexus-dashboard
- [ ] 1.4 Audit deploy/nexus-bundle-manager.sh — confirm it's web-only
- [ ] 1.5 git rm -r apps/nextjs/ packages/ui/ deploy/nexus-dashboard.service deploy/traefik/ deploy/nexus-bundle-manager.sh
- [ ] 1.6 Remove apps/nextjs and packages/ui from tsconfig.json root references
- [ ] 1.7 Remove web-related deploy steps from deploy/hooks.d/
- [ ] 1.8 Single commit "chore: retire web dashboard stack"
- [ ] 1.9 Verify no other code references @nexus/ui or @nexus/nextjs
