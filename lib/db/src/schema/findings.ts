import { index, integer, pgTable, text, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { scansTable } from "./scans";
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
 *
 * FASE 7.0.0: `scanId` referencia opcional al scan que produjo este hallazgo.
 * Los hallazgos legacy/demo tienen `scanId = NULL`.
 *
 * FASE 7.0.5 (opción B aprobada): `source_id` es nullable con ON DELETE SET
 * NULL — los hallazgos son EVIDENCIA histórica de cumplimiento y NO deben
 * desaparecer cuando se elimina la fuente; la atribución histórica queda en
 * `sourceName` (NOT NULL). Con scans ON DELETE CASCADE, al eliminar una fuente
 * sus scans desaparecen y `scan_id` queda NULL por el FK existente.
 */
export const findingsTable = pgTable(
  "findings",
  {
    id: text("id").primaryKey(),
    title: text("title").notNull(),
    dataType: text("data_type").notNull(),
    sourceId: text("source_id").references(() => sourcesTable.id, {
      onDelete: "set null",
    }),
    sourceName: text("source_name").notNull(),
    location: text("location").notNull(),
    severity: text("severity").notNull(),
    status: text("status").notNull().default("open"),
    records: integer("records").notNull(),
    detectedAt: timestamp("detected_at", { withTimezone: true }).notNull(),
    regulation: text("regulation").notNull(),
    recommendation: text("recommendation").notNull(),
    sample: text("sample").notNull(),
    scanId: text("scan_id").references(() => scansTable.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("findings_source_id_idx").on(table.sourceId),
    index("findings_scan_id_idx").on(table.scanId),
  ],
);

export const insertFindingSchema = createInsertSchema(findingsTable).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export type Finding = typeof findingsTable.$inferSelect;
export type InsertFinding = z.infer<typeof insertFindingSchema>;
