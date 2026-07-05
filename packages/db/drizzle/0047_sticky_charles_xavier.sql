CREATE TABLE "elevenlabs_credentials" (
	"id" text PRIMARY KEY NOT NULL,
	"agent_id" text NOT NULL,
	"value_encrypted" text,
	"encryption_key_id" text DEFAULT 'v1',
	"voice_id" text,
	"voice_name" text,
	"last_test_ok_at" timestamp,
	"last_test_status_code" integer,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "elevenlabs_credentials" ADD CONSTRAINT "elevenlabs_credentials_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "elevenlabs_credentials_agent_id_unique" ON "elevenlabs_credentials" USING btree ("agent_id");