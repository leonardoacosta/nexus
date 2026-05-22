CREATE TABLE "spec_sessions" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "spec_sessions_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"project" text NOT NULL,
	"spec_name" text NOT NULL,
	"session_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "spec_sessions_spec_idx" ON "spec_sessions" USING btree ("project","spec_name");--> statement-breakpoint
CREATE INDEX "spec_sessions_session_idx" ON "spec_sessions" USING btree ("session_id");