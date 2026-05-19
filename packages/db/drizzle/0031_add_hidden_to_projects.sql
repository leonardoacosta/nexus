-- Custom SQL migration file, put your code below! --

-- Spec: folder-based-project-autodiscovery
-- Adds a dedicated `hidden` removable-reference flag to projects + project_locations.
-- Distinct from `status` (archival lifecycle): a hidden row is excluded from
-- /projects and the auto-discovery scanner MUST preserve hidden=true on re-scan
-- (sticky exclude). Default false, NOT NULL — existing rows are visible.

ALTER TABLE "projects" ADD COLUMN "hidden" boolean DEFAULT false NOT NULL;
--> statement-breakpoint
ALTER TABLE "project_locations" ADD COLUMN "hidden" boolean DEFAULT false NOT NULL;
