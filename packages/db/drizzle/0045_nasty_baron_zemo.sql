CREATE TABLE "cc_decision" (
	"signal_id" text PRIMARY KEY NOT NULL,
	"area" text,
	"title" text,
	"official_source" text,
	"version" text,
	"first_seen" timestamp with time zone,
	"research" jsonb,
	"history" jsonb
);
--> statement-breakpoint
CREATE TABLE "improvement_ledger" (
	"id" text PRIMARY KEY NOT NULL,
	"domain" text,
	"repo" text,
	"target_layer" text,
	"verdict" text,
	"rationale" text,
	"ref" text,
	"source" text,
	"confidence" text,
	"lower_is_better" boolean,
	"ts" timestamp with time zone,
	"thresholds" jsonb,
	"variants" jsonb,
	"suite_results" jsonb,
	"score" jsonb,
	"baseline" jsonb,
	"tool_version" jsonb,
	"outcome" jsonb
);
--> statement-breakpoint
CREATE TABLE "workflow_run" (
	"id" text PRIMARY KEY NOT NULL,
	"tool" text NOT NULL,
	"ts" timestamp with time zone NOT NULL,
	"tool_version" jsonb,
	"payload" jsonb
);
--> statement-breakpoint
CREATE INDEX "cc_decision_area_idx" ON "cc_decision" USING btree ("area");--> statement-breakpoint
CREATE INDEX "improvement_ledger_ts_idx" ON "improvement_ledger" USING btree ("ts");--> statement-breakpoint
CREATE INDEX "improvement_ledger_source_idx" ON "improvement_ledger" USING btree ("source");--> statement-breakpoint
CREATE INDEX "improvement_ledger_verdict_idx" ON "improvement_ledger" USING btree ("verdict");--> statement-breakpoint
CREATE INDEX "workflow_run_tool_ts_idx" ON "workflow_run" USING btree ("tool","ts");