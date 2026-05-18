-- Custom SQL migration file, put your code below! --

-- Spec: enforce-pino-script-errors
-- Durable error capture for one-off scripts (backfills, ops actions, mocks).
-- Pino's DB transport batches inserts here; withErrorCapture() funnels
-- uncaught errors into the same table.

CREATE TABLE "script_errors" (
    "id" text PRIMARY KEY NOT NULL,
    "script_name" text NOT NULL,
    "level" text NOT NULL,
    "message" text NOT NULL,
    "stack" text,
    "context" jsonb,
    "machine" text,
    "exit_code" integer,
    "created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "script_errors_script_created_idx" ON "script_errors" USING btree ("script_name", "created_at");
--> statement-breakpoint
CREATE INDEX "script_errors_created_at_idx" ON "script_errors" USING btree ("created_at");