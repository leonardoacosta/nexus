-- Custom SQL migration file, put your code below! --

-- Spec: add-git-project-resolver
-- Adds two nullable text columns to sessions for git origin attribution.

ALTER TABLE "sessions" ADD COLUMN "git_provider" text;
--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "git_owner_repo" text;