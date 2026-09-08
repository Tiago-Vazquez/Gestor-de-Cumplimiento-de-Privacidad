-- FASE 7.1.0 (M0): observabilidad del scanner — migración aditiva.
-- heartbeat_at nullable: NULL = nunca latió (scans legacy y recién creados);
-- el reaper usa COALESCE(heartbeat_at, started_at) con fallback a started_at.
-- cancel_requested se crea aquí (según plan 7.1) pero queda dormida hasta 7.1.2.
ALTER TABLE "scans" ADD COLUMN "heartbeat_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "scans" ADD COLUMN "tables_scanned" integer NOT NULL DEFAULT 0;--> statement-breakpoint
ALTER TABLE "scans" ADD COLUMN "records_read" integer NOT NULL DEFAULT 0;--> statement-breakpoint
ALTER TABLE "scans" ADD COLUMN "cancel_requested" boolean NOT NULL DEFAULT false;