CREATE TABLE "session_token_turns" (
	"id" text PRIMARY KEY NOT NULL,
	"session_id" text NOT NULL,
	"ts" timestamp with time zone NOT NULL,
	"model" text NOT NULL,
	"service_tier" text,
	"input_tokens" integer NOT NULL,
	"output_tokens" integer NOT NULL,
	"cache_creation_input_tokens" integer DEFAULT 0 NOT NULL,
	"cache_read_input_tokens" integer DEFAULT 0 NOT NULL,
	"cost_usd" numeric(10, 6),
	"credential_id" text,
	"credential_fingerprint" text
);
--> statement-breakpoint
CREATE UNIQUE INDEX "session_token_turns_session_ts_uniq" ON "session_token_turns" USING btree ("session_id","ts");--> statement-breakpoint
CREATE INDEX "session_token_turns_fp_ts_idx" ON "session_token_turns" USING btree ("credential_fingerprint","ts");--> statement-breakpoint
CREATE INDEX "session_token_turns_session_idx" ON "session_token_turns" USING btree ("session_id");