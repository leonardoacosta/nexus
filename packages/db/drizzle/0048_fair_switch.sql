CREATE TABLE "credential_polls" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "credential_polls_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"credential_id" text NOT NULL,
	"fingerprint" text NOT NULL,
	"usage_5h_used" integer,
	"usage_5h_limit" integer,
	"usage_7d_used" integer,
	"usage_7d_limit" integer,
	"usage_5h_reset_at" timestamp with time zone,
	"usage_7d_reset_at" timestamp with time zone,
	"polled_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "credential_polls" ADD CONSTRAINT "credential_polls_credential_id_credentials_id_fk" FOREIGN KEY ("credential_id") REFERENCES "public"."credentials"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "credential_polls_credential_id_polled_at_idx" ON "credential_polls" USING btree ("credential_id","polled_at");--> statement-breakpoint
CREATE INDEX "credential_polls_polled_at_idx" ON "credential_polls" USING btree ("polled_at");