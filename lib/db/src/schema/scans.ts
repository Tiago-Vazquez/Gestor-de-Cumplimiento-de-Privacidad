import { sql } from "drizzle-orm";
import { boolean, index, integer, pgTable, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
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
 *
 * FASE 7.1.0 (M0) — observabilidad del scanner:
 * - `heartbeat_at`: latido del scanner en ejecución (best-effort, throttled).
 *   NULL = nunca latió (scans legacy y scans recién creados hasta el primer
 *   latido); el reaper usa COALESCE(heartbeat_at, started_at) como criterio
 *   de fresqueda con fallback seguro a `started_at`.
 * - `tables_scanned` / `records_read`: progreso acumulado reportado en cada
 *   latido (solo scans `running`).
 * - `cancel_requested`: bandera de cancelación cooperativa — reservada para
 *   7.1.2, dormida en M0.
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
    heartbeatAt: timestamp("heartbeat_at", { withTimezone: true }),
    tablesScanned: integer("tables_scanned").notNull().default(0),
    recordsRead: integer("records_read").notNull().default(0),
    cancelRequested: boolean("cancel_requested").notNull().default(false),
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
