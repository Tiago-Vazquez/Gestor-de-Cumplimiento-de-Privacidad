import { integer, pgTable, text, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

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
});

export const insertReportSchema = createInsertSchema(reportsTable).omit({
  id: true,
});

export type Report = typeof reportsTable.$inferSelect;
export type InsertReport = z.infer<typeof insertReportSchema>;
