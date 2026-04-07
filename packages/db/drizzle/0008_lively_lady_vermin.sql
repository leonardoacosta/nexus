ALTER TABLE "projects" DROP CONSTRAINT "projects_name_unique";--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "git_remote_url" text;--> statement-breakpoint
ALTER TABLE "project_locations" ADD COLUMN "git_remote_url" text;--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_name_git_remote_url_unique" UNIQUE("name","git_remote_url");