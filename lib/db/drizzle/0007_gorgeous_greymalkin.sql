-- FASE 7.2.1 (M1) — Finding lifecycle: fingerprint estable y first/last-seen.
-- Aditiva y determinista. El fingerprint se calcula en SQL con el MISMO
-- algoritmo que el servicio (normalización lower+trim y escape de `\` y `|`),
-- garantizando que nunca diverge del runtime.

ALTER TABLE "findings" ADD COLUMN "last_seen_scan_id" text;--> statement-breakpoint
ALTER TABLE "findings" ADD COLUMN "fingerprint" text;--> statement-breakpoint
ALTER TABLE "findings" ADD COLUMN "first_seen_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "findings" ADD COLUMN "last_seen_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "findings" ADD COLUMN "superseded" boolean DEFAULT false NOT NULL;--> statement-breakpoint
--> statement-breakpoint
-- Backfill determinista a partir de datos EXISTENTES (sin fechas inventadas):
-- * fingerprint = source_id | location | data_type (normalizados y escapados).
-- * first_seen_at = last_seen_at = detected_at (la única fecha real persistida).
-- * last_seen_scan_id = scan_id (el scan que lo detectó originalmente).
-- Las filas legacy sin `source_id` (fuente eliminada) mantienen fingerprint
-- NULL y quedan excluidas del lifecycle y del índice único parcial.
UPDATE "findings" SET
	"fingerprint" = concat(
		replace(replace(lower(trim("source_id")), '\', '\\'), '|', '\|'), '|',
		replace(replace(lower(trim("location")), '\', '\\'), '|', '\|'), '|',
		replace(replace(lower(trim("data_type")), '\', '\\'), '|', '\|')
	),
	"first_seen_at" = "detected_at",
	"last_seen_at" = "detected_at",
	"last_seen_scan_id" = "scan_id"
WHERE "source_id" IS NOT NULL;
--> statement-breakpoint
-- Deduplicación determinista del legado: si varias filas comparten fingerprint
-- (mismo hallazgo detectado en scans previos repetidos), se conservan como
-- canónica la de menor detected_at (tie-break por id) y las demás quedan
-- `superseded = true` (evidencia histórica intacta, excluidas del índice
-- único y del lifecycle). Orden: SIEMPRE antes de crear el índice único.
UPDATE "findings" AS f SET "superseded" = true
WHERE "fingerprint" IS NOT NULL
  AND EXISTS (
    SELECT 1 FROM "findings" AS c
    WHERE c."fingerprint" = f."fingerprint"
      AND (c."detected_at" < f."detected_at"
           OR (c."detected_at" = f."detected_at" AND c."id" < f."id"))
  );
--> statement-breakpoint
ALTER TABLE "findings" ADD CONSTRAINT "findings_last_seen_scan_id_scans_id_fk" FOREIGN KEY ("last_seen_scan_id") REFERENCES "public"."scans"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "findings_fingerprint_idx" ON "findings" USING btree ("fingerprint");--> statement-breakpoint
CREATE UNIQUE INDEX "findings_fingerprint_active_idx" ON "findings" USING btree ("fingerprint") WHERE "findings"."fingerprint" IS NOT NULL AND "findings"."superseded" = false;