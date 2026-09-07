ALTER TABLE "sources" ADD COLUMN "connection_config" jsonb;--> statement-breakpoint
ALTER TABLE "findings" ADD COLUMN "scan_id" text;--> statement-breakpoint
ALTER TABLE "findings" ADD CONSTRAINT "findings_scan_id_scans_id_fk" FOREIGN KEY ("scan_id") REFERENCES "public"."scans"("id") ON DELETE SET NULL ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "findings_scan_id_idx" ON "findings" USING btree ("scan_id");