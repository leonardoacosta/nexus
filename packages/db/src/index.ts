// Client factory
export { createDb } from "./client";
export type { Db } from "./client";

// Re-export drizzle query operators for consumers that don't depend on drizzle-orm directly
export {
  eq,
  and,
  or,
  isNull,
  isNotNull,
  desc,
  asc,
  inArray,
  notInArray,
  sql,
  max,
} from "drizzle-orm";

// Schema tables
export {
  sessions,
  healthSnapshots,
  sessionEvents,
  notifications,
  credentials,
  elevenlabsCredentials,
  agents,
  projects,
  projectLocations,
  sessionTokenTurns,
  sessionTokenWatcherState,
  ccProfiles,
  ccProfileEvents,
  notificationSettings,
} from "./schema";

// Back-compat alias: credentialEvents -> ccProfileEvents
// The rename happens in migration 0025; this alias preserves a single import
// site for the half-dozen callers that still spell it the old way and lets
// them migrate incrementally.
export { ccProfileEvents as credentialEvents } from "./schema";

// script_errors — durable error capture for one-off scripts.
export { scriptErrors, type ScriptError, type NewScriptError } from "./schema";

// Relations (used by drizzle's relational query API)
export {
  sessionsRelations,
  healthSnapshotsRelations,
  notificationsRelations,
  credentialsRelations,
  elevenlabsCredentialsRelations,
  agentsRelations,
  projectsRelations,
} from "./schema";

// Re-export existing inferred entity types defined alongside their schemas
export type {
  Agent,
  NewAgent,
  Project,
  NewProject,
  ProjectLocation,
  NewProjectLocation,
  ElevenlabsCredential,
  NewElevenlabsCredential,
  NotificationSettings,
  NewNotificationSettings,
} from "./schema";

// Inferred types for tables that don't export their own types yet
import type {
  sessions as sessionsTable,
  healthSnapshots as healthSnapshotsTable,
  sessionEvents as sessionEventsTable,
  notifications as notificationsTable,
  credentials as credentialsTable,
  sessionTokenTurns as sessionTokenTurnsTable,
  sessionTokenWatcherState as sessionTokenWatcherStateTable,
  ccProfileEvents as credentialEventsTable,
} from "./schema";

export type Session = typeof sessionsTable.$inferSelect;
export type NewSession = typeof sessionsTable.$inferInsert;

export type HealthSnapshot = typeof healthSnapshotsTable.$inferSelect;
export type NewHealthSnapshot = typeof healthSnapshotsTable.$inferInsert;

export type SessionEvent = typeof sessionEventsTable.$inferSelect;
export type NewSessionEvent = typeof sessionEventsTable.$inferInsert;

export type Notification = typeof notificationsTable.$inferSelect;
export type NewNotification = typeof notificationsTable.$inferInsert;

export type Credential = typeof credentialsTable.$inferSelect;
export type NewCredential = typeof credentialsTable.$inferInsert;

export type SessionTokenTurn = typeof sessionTokenTurnsTable.$inferSelect;
export type NewSessionTokenTurn = typeof sessionTokenTurnsTable.$inferInsert;

export type SessionTokenWatcherState =
  typeof sessionTokenWatcherStateTable.$inferSelect;
export type NewSessionTokenWatcherState =
  typeof sessionTokenWatcherStateTable.$inferInsert;

export type CredentialEvent = typeof credentialEventsTable.$inferSelect;
export type NewCredentialEvent = typeof credentialEventsTable.$inferInsert;
