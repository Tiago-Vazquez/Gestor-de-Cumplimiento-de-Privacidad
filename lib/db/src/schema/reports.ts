import { index, integer, pgTable, text, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { organizationsTable } from "./organizations";

/**
 * Informes de cumplimiento generados por la plataforma.
 *
 * `period`, `status` y `format` se almacenan como texto; el dominio se valida
 * en la capa API con los contratos ReportInputPeriod / ReportStatus /
 * ReportFormat de `@workspace/api-zod`.
 */
export const reportsTable = pgTable("reports", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  period: text("period").notNull(),
  status: text("status").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  findings: integer("findings").notNull(),
  complianceScore: integer("compliance_score").notNull(),
  format: text("format").notNull(),
  // M21.1 (ADR-001): raíz independiente (sin FK a sources) → necesita
  // tenant_id propio para ser aislable. Nullable TRANSITORIO: el backfill de
  // M21.4 asigna la organización inicial y entonces pasa a NOT NULL.
  tenantId: text("tenant_id").references(() => organizationsTable.id),
}, (table) => [
  // M21.1 (ADR-001): único patrón de consulta del repo — listado por tenant
  // ordenado por creación DESC (`reports.repo.list` ya ordena created_at DESC).
  index("reports_tenant_created_idx").on(table.tenantId, table.createdAt),
]);

export const insertReportSchema = createInsertSchema(reportsTable).omit({
  id: true,
});

export type Report = typeof reportsTable.$inferSelect;
export type InsertReport = z.infer<typeof insertReportSchema>;
