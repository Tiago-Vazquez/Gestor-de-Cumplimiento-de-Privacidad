import { index, integer, jsonb, pgTable, text, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { organizationsTable } from "./organizations";

/**
 * FASE 8 (PDF profesional) — snapshot del informe, capturado en el momento de
 * generación para que el PDF sea un artefacto inmutable y auditable (no refleja
 * el estado "vivo" de los hallazgos en el momento de descarga).
 */
export type ReportContentSeverityCounts = {
  critical: number;
  high: number;
  medium: number;
  low: number;
};

export type ReportContentRisk = {
  title: string;
  severity: string;
  dataType: string;
  source: string;
  records: number;
  regulation: string;
  recommendation: string;
};

export type ReportContent = {
  version: string;
  generatedAt: string;
  organizationName: string;
  executiveSummary: string;
  severityCounts: ReportContentSeverityCounts;
  findingsByDataType: Array<{ label: string; count: number }>;
  topRisks: ReportContentRisk[];
  recommendations: string[];
};

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
  // FASE 8 (PDF profesional): snapshot JSONB del desglose completo del informe
  // (resumen ejecutivo, severidades, tipos de dato, riesgos y recomendaciones)
  // capturado EN EL MOMENTO de generación. Nullable: los informes anteriores a
  // esta columna no tienen contenido y el download cae a un PDF mínimo.
  content: jsonb("content").$type<ReportContent>(),
  // M21.1 (ADR-001): raíz independiente (sin FK a sources) → necesita
  // tenant_id propio para ser aislable. Nullable TRANSITORIO: el backfill de
  // M21.4 asigna la organización inicial y entonces pasa a NOT NULL.
  tenantId: text("tenant_id").notNull().references(() => organizationsTable.id),
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
