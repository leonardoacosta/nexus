-- Custom SQL migration file, put your code below! --

-- Spec: add-subagent-tree-columns
-- Adds parent_session_id (FK to sessions.id) + child_role (text) to sessions.
-- Backfill script populates from session_events.metadata (event_type='agent_spawn').

ALTER TABLE "sessions" ADD COLUMN "parent_session_id" text;
--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "child_role" text;
--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_parent_session_id_fk" FOREIGN KEY ("parent_session_id") REFERENCES "sessions"("id") ON DELETE SET NULL;
--> statement-breakpoint
CREATE INDEX "sessions_parent_session_id_idx" ON "sessions" USING btree ("parent_session_id");