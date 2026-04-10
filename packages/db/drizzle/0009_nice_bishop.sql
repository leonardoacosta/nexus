ALTER TABLE "credentials" ADD COLUMN "created_at" timestamp DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "credentials" ADD COLUMN "updated_at" timestamp DEFAULT now() NOT NULL;