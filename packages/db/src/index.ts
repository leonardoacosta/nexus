export { createDb } from "./client";
export type { Db } from "./client";

// Re-export all schema tables
export {
  sessions,
  healthSnapshots,
  sessionEvents,
  notifications,
  credentials,
  agents,
} from "./schema";
