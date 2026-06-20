CREATE TABLE "fleet_presence" (
	"machine" text PRIMARY KEY NOT NULL,
	"on_console" boolean DEFAULT false NOT NULL,
	"mac_active" boolean,
	"mac_locked" boolean,
	"heartbeat" timestamp NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
