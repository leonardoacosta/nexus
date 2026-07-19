ALTER TABLE "agents" ALTER COLUMN "last_seen" SET DATA TYPE timestamp with time zone;--> statement-breakpoint
ALTER TABLE "agents" ALTER COLUMN "created_at" SET DATA TYPE timestamp with time zone;--> statement-breakpoint
ALTER TABLE "agents" ALTER COLUMN "created_at" SET DEFAULT now();--> statement-breakpoint
ALTER TABLE "agents" ALTER COLUMN "deleted_at" SET DATA TYPE timestamp with time zone;--> statement-breakpoint
ALTER TABLE "bloat_radar" ALTER COLUMN "run_timestamp" SET DATA TYPE timestamp with time zone;--> statement-breakpoint
ALTER TABLE "cc_profile_events" ALTER COLUMN "created_at" SET DATA TYPE timestamp with time zone;--> statement-breakpoint
ALTER TABLE "cc_profile_events" ALTER COLUMN "created_at" SET DEFAULT now();--> statement-breakpoint
ALTER TABLE "cc_profiles" ALTER COLUMN "created_at" SET DATA TYPE timestamp with time zone;--> statement-breakpoint
ALTER TABLE "cc_profiles" ALTER COLUMN "created_at" SET DEFAULT now();--> statement-breakpoint
ALTER TABLE "cc_profiles" ALTER COLUMN "updated_at" SET DATA TYPE timestamp with time zone;--> statement-breakpoint
ALTER TABLE "cc_profiles" ALTER COLUMN "updated_at" SET DEFAULT now();--> statement-breakpoint
ALTER TABLE "credential_swaps" ALTER COLUMN "created_at" SET DATA TYPE timestamp with time zone;--> statement-breakpoint
ALTER TABLE "credential_swaps" ALTER COLUMN "created_at" SET DEFAULT now();--> statement-breakpoint
ALTER TABLE "credentials" ALTER COLUMN "leased_at" SET DATA TYPE timestamp with time zone;--> statement-breakpoint
ALTER TABLE "credentials" ALTER COLUMN "cooldown_until" SET DATA TYPE timestamp with time zone;--> statement-breakpoint
ALTER TABLE "credentials" ALTER COLUMN "created_at" SET DATA TYPE timestamp with time zone;--> statement-breakpoint
ALTER TABLE "credentials" ALTER COLUMN "created_at" SET DEFAULT now();--> statement-breakpoint
ALTER TABLE "credentials" ALTER COLUMN "updated_at" SET DATA TYPE timestamp with time zone;--> statement-breakpoint
ALTER TABLE "credentials" ALTER COLUMN "updated_at" SET DEFAULT now();--> statement-breakpoint
ALTER TABLE "cron_runs" ALTER COLUMN "timestamp" SET DATA TYPE timestamp with time zone;--> statement-breakpoint
ALTER TABLE "elevenlabs_credentials" ALTER COLUMN "last_test_ok_at" SET DATA TYPE timestamp with time zone;--> statement-breakpoint
ALTER TABLE "elevenlabs_credentials" ALTER COLUMN "created_at" SET DATA TYPE timestamp with time zone;--> statement-breakpoint
ALTER TABLE "elevenlabs_credentials" ALTER COLUMN "created_at" SET DEFAULT now();--> statement-breakpoint
ALTER TABLE "elevenlabs_credentials" ALTER COLUMN "updated_at" SET DATA TYPE timestamp with time zone;--> statement-breakpoint
ALTER TABLE "elevenlabs_credentials" ALTER COLUMN "updated_at" SET DEFAULT now();--> statement-breakpoint
ALTER TABLE "fleet_presence" ALTER COLUMN "heartbeat" SET DATA TYPE timestamp with time zone;--> statement-breakpoint
ALTER TABLE "fleet_presence" ALTER COLUMN "updated_at" SET DATA TYPE timestamp with time zone;--> statement-breakpoint
ALTER TABLE "fleet_presence" ALTER COLUMN "updated_at" SET DEFAULT now();--> statement-breakpoint
ALTER TABLE "health_snapshots" ALTER COLUMN "timestamp" SET DATA TYPE timestamp with time zone;--> statement-breakpoint
ALTER TABLE "hook_schema_fingerprints" ALTER COLUMN "first_seen" SET DATA TYPE timestamp with time zone;--> statement-breakpoint
ALTER TABLE "hook_schema_fingerprints" ALTER COLUMN "first_seen" SET DEFAULT now();--> statement-breakpoint
ALTER TABLE "hook_schema_fingerprints" ALTER COLUMN "last_seen" SET DATA TYPE timestamp with time zone;--> statement-breakpoint
ALTER TABLE "hook_schema_fingerprints" ALTER COLUMN "last_seen" SET DEFAULT now();--> statement-breakpoint
ALTER TABLE "integration_credentials" ALTER COLUMN "last_test_ok_at" SET DATA TYPE timestamp with time zone;--> statement-breakpoint
ALTER TABLE "integration_credentials" ALTER COLUMN "created_at" SET DATA TYPE timestamp with time zone;--> statement-breakpoint
ALTER TABLE "integration_credentials" ALTER COLUMN "created_at" SET DEFAULT now();--> statement-breakpoint
ALTER TABLE "integration_credentials" ALTER COLUMN "updated_at" SET DATA TYPE timestamp with time zone;--> statement-breakpoint
ALTER TABLE "integration_credentials" ALTER COLUMN "updated_at" SET DEFAULT now();--> statement-breakpoint
ALTER TABLE "notification_settings" ALTER COLUMN "updated_at" SET DATA TYPE timestamp with time zone;--> statement-breakpoint
ALTER TABLE "notification_settings" ALTER COLUMN "updated_at" SET DEFAULT now();--> statement-breakpoint
ALTER TABLE "notifications" ALTER COLUMN "created_at" SET DATA TYPE timestamp with time zone;--> statement-breakpoint
ALTER TABLE "notifications" ALTER COLUMN "sent_at" SET DATA TYPE timestamp with time zone;--> statement-breakpoint
ALTER TABLE "presence_holds" ALTER COLUMN "hold_until" SET DATA TYPE timestamp with time zone;--> statement-breakpoint
ALTER TABLE "presence_holds" ALTER COLUMN "created_at" SET DATA TYPE timestamp with time zone;--> statement-breakpoint
ALTER TABLE "presence_holds" ALTER COLUMN "created_at" SET DEFAULT now();--> statement-breakpoint
ALTER TABLE "presence_holds" ALTER COLUMN "released_at" SET DATA TYPE timestamp with time zone;--> statement-breakpoint
ALTER TABLE "process_watcher_state" ALTER COLUMN "observed_at" SET DATA TYPE timestamp with time zone;--> statement-breakpoint
ALTER TABLE "process_watcher_state" ALTER COLUMN "observed_at" SET DEFAULT now();--> statement-breakpoint
ALTER TABLE "routing_rules" ALTER COLUMN "updated_at" SET DATA TYPE timestamp with time zone;--> statement-breakpoint
ALTER TABLE "routing_rules" ALTER COLUMN "updated_at" SET DEFAULT now();--> statement-breakpoint
ALTER TABLE "script_errors" ALTER COLUMN "created_at" SET DATA TYPE timestamp with time zone;--> statement-breakpoint
ALTER TABLE "script_errors" ALTER COLUMN "created_at" SET DEFAULT now();--> statement-breakpoint
ALTER TABLE "session_events" ALTER COLUMN "timestamp" SET DATA TYPE timestamp with time zone;--> statement-breakpoint
ALTER TABLE "sessions" ALTER COLUMN "started_at" SET DATA TYPE timestamp with time zone;--> statement-breakpoint
ALTER TABLE "sessions" ALTER COLUMN "last_activity" SET DATA TYPE timestamp with time zone;--> statement-breakpoint
ALTER TABLE "sessions" ALTER COLUMN "ended_at" SET DATA TYPE timestamp with time zone;--> statement-breakpoint
ALTER TABLE "sessions" ALTER COLUMN "rate_limit_reset_at" SET DATA TYPE timestamp with time zone;--> statement-breakpoint
ALTER TABLE "sessions" ALTER COLUMN "idle_since" SET DATA TYPE timestamp with time zone;--> statement-breakpoint
ALTER TABLE "projects" ALTER COLUMN "discovered_at" SET DATA TYPE timestamp with time zone;--> statement-breakpoint
ALTER TABLE "projects" ALTER COLUMN "discovered_at" SET DEFAULT now();--> statement-breakpoint
ALTER TABLE "projects" ALTER COLUMN "updated_at" SET DATA TYPE timestamp with time zone;--> statement-breakpoint
ALTER TABLE "projects" ALTER COLUMN "updated_at" SET DEFAULT now();--> statement-breakpoint
ALTER TABLE "project_locations" ALTER COLUMN "last_discovered_at" SET DATA TYPE timestamp with time zone;--> statement-breakpoint
ALTER TABLE "project_locations" ALTER COLUMN "created_at" SET DATA TYPE timestamp with time zone;--> statement-breakpoint
ALTER TABLE "project_locations" ALTER COLUMN "created_at" SET DEFAULT now();