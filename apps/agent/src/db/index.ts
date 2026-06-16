export { openDatabase } from "./database";
export {
  insertSession,
  updateSessionStatus,
  recordSessionStop,
  queryActiveSessions,
  queryRecentSessions,
  getSessionById,
} from "./sessions";
export type { SessionRow } from "./sessions";
export { insertHealthSnapshot, queryHealthTimeSeries } from "./health";
export type { HealthSnapshotRow } from "./health";
export { appendSessionEvent, querySessionEvents } from "./events";
export type { SessionEventRow } from "./events";
export { runRetentionCleanup, scheduleRetention } from "./retention";

// Re-export @nexus/db for convenience
export type { Db } from "@nexus/db";
export {
  sessions,
  healthSnapshots,
  sessionEvents,
  notifications,
  credentials,
} from "@nexus/db";

// Notification buffer
export {
  insertNotification,
  queryNotificationsByStatus,
  markNotificationDelivered,
  markNotificationExpired,
  getNotificationById,
} from "../notifications/buffer";
export type { NotificationRow } from "../notifications/buffer";

// Credential store
export {
  insertCredential,
  getCredentialById,
  queryAllCredentials,
  queryCredentialsByStatus,
  updateCredentialStatus,
  queryExpiredCooldowns,
  queryStaleLeases,
} from "../credentials/store";
export type { CredentialRow } from "../credentials/store";
