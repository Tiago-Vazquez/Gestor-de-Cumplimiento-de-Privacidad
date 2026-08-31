import { index, integer, pgTable, text, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { sourcesTable } from "./sources";

/**
 * Ejecuciones de escaneo sobre una fuente de datos.
 *
 * El ciclo expuesto por la API es `running` → `completed`; `queued` queda
 * reservado para el contrato. `completedAt` es nulo mientras el escaneo está
 * en curso y `findingsCreated` se rellena al completar.
 */
export const scansTable = pgTable(
  "scans",
  {
    id: text("id").primaryKey(),
    sourceId: text("source_id")
      .notNull()
      .references(() => sourcesTable.id),
    status: text("status").notNull(),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    findingsCreated: integer("findings_created").notNull().default(0),
  },
  (table) => [index("scans_source_id_idx").on(table.sourceId)],
);

export const insertScanSchema = createInsertSchema(scansTable).omit({
  id: true,
});

export type Scan = typeof scansTable.$inferSelect;
export type InsertScan = z.infer<typeof insertScanSchema>;
