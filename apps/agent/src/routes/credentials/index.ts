/**
 * Credential routes barrel.
 *
 * Re-exports the full public surface of `apps/agent/src/routes/credentials.ts`
 * (pre-split). Consumers continue to import from `./credentials` — the parent
 * file is now a thin re-export of this barrel.
 *
 * 13 exports total:
 *   Lifecycle:  initCredentialRoutes, getCredentialPool, resetCredentialRoutes
 *   CRUD:       handleAddCredential, handleListCredentials, handleDeleteCredential
 *   Lease:      handleLeaseCredential, handleReleaseCredential
 *   Promote:    handlePromoteCredential, handleReportRateLimit
 *   Read-only:  handleCredentialHealth, handleCredentialUsage
 *   Swap:       handleSwapCredential
 */

export {
  initCredentialRoutes,
  getCredentialPool,
  resetCredentialRoutes,
} from "./init";

export {
  handleAddCredential,
  handleListCredentials,
  handleDeleteCredential,
} from "./handlers-crud";

export {
  handleLeaseCredential,
  handleReleaseCredential,
} from "./handlers-lease";

export {
  handlePromoteCredential,
  handleReportRateLimit,
} from "./handlers-promote";

export {
  handleCredentialHealth,
  handleCredentialUsage,
} from "./handlers-health-usage";

export { handleSwapCredential } from "./handlers-swap";

export { handleGetActiveCredential } from "./handlers-active";

export {
  handleRefreshIdentity,
  handleRefreshIdentityAll,
} from "./handlers-refresh-identity";
