-- Custom SQL migration file, put your code below! --

-- Spec: add-schema-drift-detector
-- Tracks the (event_type, fingerprint) pairs observed on the hooks ingress.
-- A new pair triggers a `HookSchemaDrift` lifecycle event (rate-limited).

CREATE TABLE "hook_schema_fingerprints" (
    "event_type" text NOT NULL,
    "fingerprint" text NOT NULL,
    "first_seen" timestamp DEFAULT now() NOT NULL,
    "last_seen" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "hook_schema_fingerprints_event_fp_uidx" ON "hook_schema_fingerprints" USING btree ("event_type", "fingerprint");
--> statement-breakpoint
CREATE INDEX "hook_schema_fingerprints_event_idx" ON "hook_schema_fingerprints" USING btree ("event_type");