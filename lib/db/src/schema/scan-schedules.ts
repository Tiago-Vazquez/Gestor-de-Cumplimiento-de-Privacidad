import { sql } from "drizzle-orm";
import { boolean, index, integer, pgTable, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { sourcesTable } from "./sources";

/**
 * Horarios de escaneo automático por fuente (M10 — Scheduled Scans).
 *
 * Una fila por fuente (índice único sobre `source_id`); sin fila = solo
 * escaneo manual. La FK es ON DELETE CASCADE: eliminar una fuente elimina su
 * horario (mismo criterio que `scans`).
 *
 * El scheduler reclama vencimientos con el índice parcial
 * `scan_schedules_due_idx` (solo filas habilitadas) y avanza `next_run_at`
 * dentro de la transacción de claim, garantizando que dos ticks nunca
 * despachan dos veces el mismo vencimiento.
 *
 * `last_status` refleja el resultado del despacho (`ok | skipped | error`),
 * no el estado del scan (ese vive en `scans.status`).
 */
export const scanSchedulesTable = pgTable(
  "scan_schedules",
  {
    id: text("id").primaryKey(),
    sourceId: text("source_id")
      .notNull()
      .references(() => sourcesTable.id, { onDelete: "cascade" }),
    enabled: boolean("enabled").notNull().default(false),
    intervalMinutes: integer("interval_minutes").notNull(),
    nextRunAt: timestamp("next_run_at", { withTimezone: true }),
    lastRunAt: timestamp("last_run_at", { withTimezone: true }),
    lastStatus: text("last_status"),
    lastError: text("last_error"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("scan_schedules_source_id_key").on(table.sourceId),
    index("scan_schedules_due_idx")
      .on(table.nextRunAt)
      .where(sql`${table.enabled} = true`),
  ],
);

export const insertScanScheduleSchema = createInsertSchema(scanSchedulesTable).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export type ScanSchedule = typeof scanSchedulesTable.$inferSelect;
export type InsertScanSchedule = z.infer<typeof insertScanScheduleSchema>;
