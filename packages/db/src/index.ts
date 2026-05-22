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
  agents,
  projects,
  projectLocations,
  sessionTokenTurns,
  sessionTokenWatcherState,
  ccProfiles,
  ccProfileEvents,
  notificationSettings,
  hookSchemaFingerprints,
} from "./schema";

export type {
  HookSchemaFingerprint,
  NewHookSchemaFingerprint,
} from "./schema";

// Back-compat alias: credentialEvents -> ccProfileEvents
// The rename happens in migration 0025; this alias preserves a single import
// site for the half-dozen callers that still spell it the old way and lets
// them migrate incrementally.
export { ccProfileEvents as credentialEvents } from "./schema";

// script_errors — durable error capture for one-off scripts.
export { scriptErrors, type ScriptError, type NewScriptError } from "./schema";

// cron_runs + bloat_radar — telemetry tables for the in-process nx-cron
// service (adopt-reaper-into-nx-cron). cron_runs gets one row per job tick;
// bloat_radar gets one row per over-threshold finding (zero rows on a clear
// run). Both are pruned by `apps/agent/src/db/retention.ts` at 90 days.
export {
  cronRuns,
  type CronRun,
  type NewCronRun,
  bloatRadar,
  type BloatRadar,
  type NewBloatRadar,
} from "./schema";

// project_voice_overrides — per-project ElevenLabs voice id mapping
// (notifications-overhaul). Backs `/notifications/voices*` endpoints +
// the TTSObserver's projectVoiceCache.
export {
  projectVoiceOverrides,
  type ProjectVoiceOverride,
  type NewProjectVoiceOverride,
} from "./schema";

// spec_sessions — many-to-many join between specs (project + name slug) and
// sessions (session_id), written by POST /session/start when the caller
// passes spec_slug. Survives session close — historical lookups
// ("which sessions touched spec X?") drive the Swift dashboard's per-row
// session count chip. Pruned at 365 days by retention.ts.
// Spec: openspec/changes/specs-tab-start-on-spec.
export {
  specSessions,
  type SpecSession,
  type NewSpecSession,
} from "./schema";

// Relations (used by drizzle's relational query API)
export {
  sessionsRelations,
  healthSnapshotsRelations,
  notificationsRelations,
  credentialsRelations,
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
