CREATE TABLE "masking_jobs" (
	"id" text PRIMARY KEY NOT NULL,
	"source_id" text NOT NULL,
	"fields" jsonb NOT NULL,
	"status" text NOT NULL,
	"records" integer DEFAULT 0 NOT NULL,
	"error" text,
	"dataset" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "masking_jobs" ADD CONSTRAINT "masking_jobs_source_id_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."sources"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "masking_jobs_source_id_idx" ON "masking_jobs" USING btree ("source_id");--> statement-breakpoint
CREATE INDEX "masking_jobs_created_at_idx" ON "masking_jobs" USING btree ("created_at");