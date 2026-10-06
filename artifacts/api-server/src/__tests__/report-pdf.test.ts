import { describe, expect, it } from "vitest";
import type { Report, ReportContent } from "@workspace/db";
import { generateReportPdf } from "../services/report-pdf";

const report: Report = {
  id: "r-001",
  name: "Auditoría Q2",
  period: "last_30d",
  status: "ready",
  createdAt: new Date("2026-09-01T10:00:00.000Z"),
  findings: 42,
  complianceScore: 87,
  format: "pdf",
  content: null,
  tenantId: "org-1",
};

const content: ReportContent = {
  version: "1.0",
  generatedAt: "2026-09-01T10:00:00.000Z",
  organizationName: "Acme Corp",
  executiveSummary:
    "Informe de cumplimiento de Acme Corp. El compliance score es 87 / 100 sobre 42 hallazgos activos (2 críticos, 5 altos, 10 medios y 25 bajos).",
  severityCounts: { critical: 2, high: 5, medium: 10, low: 25 },
  findingsByDataType: [
    { label: "email", count: 20 },
    { label: "phone", count: 12 },
    { label: "credit_card", count: 10 },
  ],
  topRisks: [
    {
      title: "Tarjetas de crédito en logs de checkout",
      severity: "critical",
      dataType: "credit_card",
      source: "Production DB",
      records: 1240,
      regulation: "PCI DSS",
      recommendation: "Tokenizar los números de tarjeta antes de persistirlos.",
    },
    {
      title: "Emails de clientes en tablas de analytics",
      severity: "high",
      dataType: "email",
      source: "Analytics",
      records: 8300,
      regulation: "GDPR",
      recommendation: "Pseudonimizar los emails en el pipeline de analytics.",
    },
  ],
  recommendations: [
    "Tokenizar los números de tarjeta antes de persistirlos.",
    "Pseudonimizar los emails en el pipeline de analytics.",
  ],
};

describe("generateReportPdf", () => {
  it("produce un PDF válido a partir del snapshot content", async () => {
    const pdf = await generateReportPdf({ ...report, content }, content);
    expect(pdf).toBeInstanceOf(Uint8Array);
    expect(pdf.length).toBeGreaterThan(500);
    expect(Buffer.from(pdf).subarray(0, 4).toString("latin1")).toBe("%PDF");
  });

  it("cae a un PDF mínimo cuando el reporte no tiene content (legacy)", async () => {
    const pdf = await generateReportPdf({ ...report, content: null }, null);
    expect(pdf).toBeInstanceOf(Uint8Array);
    expect(pdf.length).toBeGreaterThan(300);
    expect(Buffer.from(pdf).subarray(0, 4).toString("latin1")).toBe("%PDF");
  });
});
