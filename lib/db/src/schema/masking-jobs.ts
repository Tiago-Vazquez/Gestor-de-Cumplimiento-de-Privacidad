import {
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
} from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { sourcesTable } from "./sources";

/**
 * FASE 7.3 / M5.c — Trabajo de anonimización (masking job).
 *
 * Metadatos del job + el dataset anonimizado persistido (`dataset` jsonb).
 * Decisiones (diagnóstico aprobado):
 * - Persistencia A1: el dataset vive en la propia fila; el download lo lee
 *   directamente (nunca relee la fuente ni re-anonimiza).
 * - `dataset` NUNCA se mapea al contrato `MaskingJob` (ni listado ni
 *   detalle); solo el handler de download lo serializa.
 * - Síncrono: al responder el POST el job ya es `ready` o `failed`
 *   (queued/running quedan reservados en el contrato).
 * - FK CASCADE igual que scans: los scans/jobs son filas operativas de una
 *   fuente; el historial conservado son findings y actividad (ambas con
 *   sourceId texto nullable, no FK), no los jobs.
 */
export const maskingJobsTable = pgTable(
  "masking_jobs",
  {
    id: text("id").primaryKey(),
    sourceId: text("source_id")
      .notNull()
      .references(() => sourcesTable.id, { onDelete: "cascade" }),
    /** Columnas a anonimizar; cada nombre ∈ MASKABLE_FIELDS (M5.b) */
    fields: jsonb("fields").notNull().$type<string[]>(),
    /** ready | failed (queued/running reservados por contrato) */
    status: text("status").notNull(),
    records: integer("records").notNull().default(0),
    /** dataset_too_large | source_unreachable | ... (sin secretos ni PII) */
    error: text("error"),
    /** { fields, rows } — solo presente si status='ready' */
    dataset: jsonb("dataset").$type<{
      fields: string[];
      rows: Record<string, string>[];
    } | null>(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
  },
  (table) => [
    index("masking_jobs_source_id_idx").on(table.sourceId),
    index("masking_jobs_created_at_idx").on(table.createdAt),
  ],
);

export const insertMaskingJobSchema = createInsertSchema(maskingJobsTable).omit({
  id: true,
});

export type MaskingJob = typeof maskingJobsTable.$inferSelect;
export type InsertMaskingJob = z.infer<typeof insertMaskingJobSchema>;
