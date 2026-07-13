CREATE TABLE "integration_credentials" (
	"id" text PRIMARY KEY NOT NULL,
	"provider" text NOT NULL,
	"agent_id" text NOT NULL,
	"value_encrypted" text,
	"encryption_key_id" text DEFAULT 'v1',
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"last_test_ok_at" timestamp,
	"last_test_status_code" integer,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "integration_credentials" ADD CONSTRAINT "integration_credentials_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "integration_credentials_agent_provider_unique" ON "integration_credentials" USING btree ("agent_id","provider");