CREATE TABLE "session_token_watcher_state" (
	"session_id" text PRIMARY KEY NOT NULL,
	"transcript_path" text NOT NULL,
	"byte_offset" bigint DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
