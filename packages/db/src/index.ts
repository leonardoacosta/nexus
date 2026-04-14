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
} from "./schema";

// Inferred types for tables that don't export their own types yet
import type {
  sessions as sessionsTable,
  healthSnapshots as healthSnapshotsTable,
  sessionEvents as sessionEventsTable,
  notifications as notificationsTable,
  credentials as credentialsTable,
  sessionTokenTurns as sessionTokenTurnsTable,
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
