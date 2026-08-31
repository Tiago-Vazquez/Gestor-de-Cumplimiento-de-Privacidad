import { index, integer, pgTable, text, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { sourcesTable } from "./sources";

/**
 * Hallazgos de datos personales detectados en las fuentes monitoreadas.
 *
 * `dataType`, `severity` y `status` se almacenan como texto; su dominio se
 * valida en la capa API con los contratos de `@workspace/api-zod`
 * (FindingDataType / FindingSeverity / FindingStatus).
 *
 * `sourceName` se guarda denormalizado para servir el contrato de la API sin
 * joins; `sourceId` mantiene la referencia relacional con la fuente.
 */
export const findingsTable = pgTable(
  "findings",
  {
    id: text("id").primaryKey(),
    title: text("title").notNull(),
    dataType: text("data_type").notNull(),
    sourceId: text("source_id")
      .notNull()
      .references(() => sourcesTable.id),
    sourceName: text("source_name").notNull(),
    location: text("location").notNull(),
    severity: text("severity").notNull(),
    status: text("status").notNull().default("open"),
    records: integer("records").notNull(),
    detectedAt: timestamp("detected_at", { withTimezone: true }).notNull(),
    regulation: text("regulation").notNull(),
    recommendation: text("recommendation").notNull(),
    sample: text("sample").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("findings_source_id_idx").on(table.sourceId)],
);

export const insertFindingSchema = createInsertSchema(findingsTable).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export type Finding = typeof findingsTable.$inferSelect;
export type InsertFinding = z.infer<typeof insertFindingSchema>;
