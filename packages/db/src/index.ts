export { createDb } from "./client";
export type { Db } from "./client";

// Re-export drizzle query operators for consumers that don't depend on drizzle-orm directly
export { eq, and, or, isNull, isNotNull, desc, asc } from "drizzle-orm";

// Re-export all schema tables
export {
  sessions,
  healthSnapshots,
  sessionEvents,
  notifications,
  credentials,
  agents,
} from "./schema";
