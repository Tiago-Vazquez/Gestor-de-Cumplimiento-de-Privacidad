import type { Activity, Finding, Report, Rule, Scan, Source } from "@workspace/db";
import type { ComplianceSummaryData, ComplianceTrendData } from "./repositories/compliance.repo";

/**
 * Mapeadores fila-BaseDeDatos → contrato de la API (@workspace/api-zod).
 *
 * Mantienen los contratos OpenAPI/Zod intactos mientras la capa de
 * persistencia pasa de datos demo en memoria a PostgreSQL. Cada decisión
 * derivada de una discrepancia contrato↔BD está marcada con su ID (D1, D2…)
 * del informe de auditoría de FASE 5.
 */

/** D1: el contrato exige `lastScanAt: string`; una fuente nunca escaneada
 * tiene la columna nula, así que se usa su fecha de creación como valor
 * documentado y estable. */
export function mapSource(source: Source & { findingsCount: number }) {
  return {
    id: source.id,
    name: source.name,
    kind: source.kind,
    environment: source.environment,
    status: source.status,
    lastScanAt: (source.lastScanAt ?? source.createdAt).toISOString(),
    tables: source.tables,
    records: source.records,
    findings: source.findingsCount,
  };
}

/** D4: `sample` es NOT NULL en la BD y opcional/nullable en el contrato;
 * se sirve siempre el valor enmascarado que se insertó. */
export function mapFinding(finding: Finding) {
  return {
    id: finding.id,
    title: finding.title,
    dataType: finding.dataType,
    source: finding.sourceName,
    location: finding.location,
    severity: finding.severity,
    status: finding.status,
    records: finding.records,
    detectedAt: finding.detectedAt.toISOString(),
    regulation: finding.regulation,
    recommendation: finding.recommendation,
    sample: finding.sample,
  };
}

/** D2: el contrato exige `lastTriggered: string`; `null` en BD significa
 * que la regla nunca se ha disparado y se expone como "Nunca". */
export function mapRule(rule: Rule) {
  return {
    id: rule.id,
    name: rule.name,
    category: rule.category,
    regulation: rule.regulation,
    enabled: rule.enabled,
    detections: rule.detections,
    lastTriggered: rule.lastTriggered ? rule.lastTriggered.toISOString() : "Nunca",
  };
}

/** D5: `findingsCreated` es opcional en el contrato pero NOT NULL con
 * default 0 en la BD; se expone siempre. FASE 7.1.1 (M1): el contrato `Scan`
 * extendido expone además el progreso acumulado del último latido
 * (`tablesScanned`/`recordsRead`, NOT NULL con default 0). */
export function mapScan(scan: Scan) {
  return {
    id: scan.id,
    sourceId: scan.sourceId,
    status: scan.status,
    startedAt: scan.startedAt.toISOString(),
    completedAt: scan.completedAt ? scan.completedAt.toISOString() : null,
    findingsCreated: scan.findingsCreated,
    tablesScanned: scan.tablesScanned,
    recordsRead: scan.recordsRead,
  };
}

/** D6: `format` es opcional en el contrato pero NOT NULL en la BD. */
export function mapReport(report: Report) {
  return {
    id: report.id,
    name: report.name,
    period: report.period,
    status: report.status,
    createdAt: report.createdAt.toISOString(),
    findings: report.findings,
    complianceScore: report.complianceScore,
    format: report.format,
  };
}

export function mapActivity(activity: Activity) {
  return {
    id: activity.id,
    type: activity.type,
    title: activity.title,
    description: activity.description,
    createdAt: activity.createdAt.toISOString(),
    severity: activity.severity,
  };
}

/**
 * Contrato `ComplianceSummary` (FASE 7.2, M2.c): el repositorio ya entrega los
 * valores agregados con el criterio canónico D8 (`activeFindingsWhere`); el
 * mapper es la frontera dominio→API y no transforma nada (todo son números y
 * claves ya contractuales). La validación final la hace la ruta con el zod
 * generado (`GetComplianceResponse`).
 */
export function mapComplianceSummary(data: ComplianceSummaryData) {
  return {
    complianceScore: data.complianceScore,
    openFindings: data.openFindings,
    findingsBySeverity: data.findingsBySeverity,
    findingsByDataType: data.findingsByDataType,
    findingsBySource: data.findingsBySource,
  };
}

/**
 * Contrato `ComplianceTrend`: los puntos ya son días calendario UTC
 * (`YYYY-MM-DD`, cadenas — identidad de bucket por diseño del contrato, no
 * timestamps), así que el mapper es passthrough tipado.
 */
export function mapComplianceTrend(data: ComplianceTrendData) {
  return {
    days: data.days,
    points: data.points.map((point) => ({
      date: point.date,
      newFindings: point.newFindings,
      resolvedFindings: point.resolvedFindings,
      completedScans: point.completedScans,
      recordsScanned: point.recordsScanned,
    })),
  };
}
