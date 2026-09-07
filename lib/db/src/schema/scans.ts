import { sql } from "drizzle-orm";
import {
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { sourcesTable } from "./sources";

/**
 * Ejecuciones de escaneo sobre una fuente de datos.
 *
 * El ciclo expuesto por la API es `running` → `completed | failed`; `queued`
 * queda reservado para el contrato. `completedAt` es nulo mientras el escaneo
 * está en curso y `findingsCreated` se rellena al completar con la cantidad
 * de hallazgos creados POR ESE scan (FASE 7.0.5).
 *
 * FASE 7.0.5:
 * - `source_id` es ON DELETE CASCADE: eliminar una fuente elimina sus scans
 *   (filas operativas efímeras); la evidencia de cumplimiento vive en
 *   `findings` (SET NULL allí).
 * - Índice único parcial: máximo UN scan `running` por fuente, garantizado
 *   por PostgreSQL incluso ante dos POST simultáneos.
 */
export const scansTable = pgTable(
  "scans",
  {
    id: text("id").primaryKey(),
    sourceId: text("source_id")
      .notNull()
      .references(() => sourcesTable.id, { onDelete: "cascade" }),
    status: text("status").notNull(),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    findingsCreated: integer("findings_created").notNull().default(0),
  },
  (table) => [
    index("scans_source_id_idx").on(table.sourceId),
    uniqueIndex("scans_one_running_per_source_idx")
      .on(table.sourceId)
      .where(sql`${table.status} = 'running'`),
  ],
);

export const insertScanSchema = createInsertSchema(scansTable).omit({
  id: true,
});

export type Scan = typeof scansTable.$inferSelect;
export type InsertScan = z.infer<typeof insertScanSchema>;
