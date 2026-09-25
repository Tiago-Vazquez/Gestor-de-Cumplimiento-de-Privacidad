CREATE TABLE "scan_schedules" (
	"id" text PRIMARY KEY NOT NULL,
	"source_id" text NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"interval_minutes" integer NOT NULL,
	"next_run_at" timestamp with time zone,
	"last_run_at" timestamp with time zone,
	"last_status" text,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "scan_schedules" ADD CONSTRAINT "scan_schedules_source_id_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."sources"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "scan_schedules_source_id_key" ON "scan_schedules" USING btree ("source_id");--> statement-breakpoint
CREATE INDEX "scan_schedules_due_idx" ON "scan_schedules" USING btree ("next_run_at") WHERE "scan_schedules"."enabled" = true;