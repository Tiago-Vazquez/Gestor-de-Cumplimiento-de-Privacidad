import { describe, expect, it, vi } from "vitest";

// `@workspace/db` exige DATABASE_URL al importarse (lanza en el index del
// paquete). Estos tests solo ejercitan la capa PURA del repositorio
// (agregación y validación de rango), así que el módulo completo se sustituye
// por stubs antes de cargar compliance.repo (mismo patrón que las suites HTTP
// con mock-repos, pero mínimo porque no se ejecuta SQL).
vi.mock("@workspace/db", () => ({
  db: {},
  findingsTable: {},
  scansTable: {},
  activityTable: {},
}));

import {
  COMPLIANCE_TREND_DEFAULT_DAYS,
  COMPLIANCE_TREND_MAX_DAYS,
  getComplianceTrend,
  summarizeComplianceAggregates,
} from "../repositories/compliance.repo";

describe("summarizeComplianceAggregates", () => {
  it("agrega severidades con las 4 claves siempre presentes y openFindings exacto", () => {
    const result = summarizeComplianceAggregates({
      severityRows: [
        { severity: "critical", total: 2 },
        { severity: "high", total: 1 },
      ],
      dataTypeRows: [{ dataType: "email", total: 3 }],
      sourceRows: [],
    });
    expect(result.openFindings).toBe(3);
    expect(result.findingsBySeverity).toEqual({ critical: 2, high: 1, medium: 0, low: 0 });
  });

  it("una severidad fuera de dominio cuenta en openFindings sin alterar las 4 claves", () => {
    // El WHERE ya es el canónico: la suma debe ser exacta aunque la fila no
    // quepa en ninguna de las 4 claves del contrato.
    const result = summarizeComplianceAggregates({
      severityRows: [
        { severity: "critical", total: 1 },
        { severity: "severe", total: 5 },
      ],
      dataTypeRows: [],
      sourceRows: [],
    });
    expect(result.openFindings).toBe(6);
    expect(result.findingsBySeverity).toEqual({ critical: 1, high: 0, medium: 0, low: 0 });
  });

  it("sin filas devuelve todo en cero y colecciones vacías", () => {
    const result = summarizeComplianceAggregates({
      severityRows: [],
      dataTypeRows: [],
      sourceRows: [],
    });
    expect(result).toEqual({
      openFindings: 0,
      findingsBySeverity: { critical: 0, high: 0, medium: 0, low: 0 },
      findingsByDataType: {},
      findingsBySource: [],
    });
  });

  it("byDataType solo incluye dataTypes con al menos un finding activo", () => {
    const result = summarizeComplianceAggregates({
      severityRows: [{ severity: "low", total: 4 }],
      dataTypeRows: [
        { dataType: "email", total: 3 },
        { dataType: "password", total: 1 },
      ],
      sourceRows: [],
    });
    expect(result.findingsByDataType).toEqual({ email: 3, password: 1 });
  });

  it("bySource excluye huérfanos (sourceId NULL) y ordena openFindings DESC, sourceName ASC", () => {
    const result = summarizeComplianceAggregates({
      severityRows: [{ severity: "open", total: 12 }],
      dataTypeRows: [],
      sourceRows: [
        { sourceId: "s-3", sourceName: "Beta", openFindings: 2 },
        { sourceId: null, sourceName: "Fuente eliminada", openFindings: 9 }, // huérfano
        { sourceId: "s-2", sourceName: "Alpha", openFindings: 5 },
        { sourceId: "s-1", sourceName: "Alpha", openFindings: 5 },
      ],
    });
    // Alpha (5) antes que Beta (2); empate Alpha/Alpha resuelto por sourceId.
    expect(result.findingsBySource).toEqual([
      { sourceId: "s-1", sourceName: "Alpha", openFindings: 5 },
      { sourceId: "s-2", sourceName: "Alpha", openFindings: 5 },
      { sourceId: "s-3", sourceName: "Beta", openFindings: 2 },
    ]);
  });
});

describe("getComplianceTrend (validación defensiva de ventana)", () => {
  it("rechaza days menores que 1", async () => {
    await expect(getComplianceTrend(0)).rejects.toThrow(RangeError);
    await expect(getComplianceTrend(-1)).rejects.toThrow(RangeError);
  });

  it("rechaza days mayores que el máximo del contrato (90)", async () => {
    await expect(getComplianceTrend(COMPLIANCE_TREND_MAX_DAYS + 1)).rejects.toThrow(RangeError);
  });

  it("rechaza days no enteros", async () => {
    await expect(getComplianceTrend(2.5)).rejects.toThrow(RangeError);
    await expect(getComplianceTrend(Number.NaN)).rejects.toThrow(RangeError);
  });

  it("el error menciona el rango permitido 1..90", async () => {
    await expect(getComplianceTrend(0)).rejects.toThrow(/1\.\.90/);
  });

  it("los espejos del contrato OpenAPI son default=30 y max=90", () => {
    expect(COMPLIANCE_TREND_DEFAULT_DAYS).toBe(30);
    expect(COMPLIANCE_TREND_MAX_DAYS).toBe(90);
  });
});
