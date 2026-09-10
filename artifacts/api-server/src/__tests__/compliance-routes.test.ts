import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import request from "supertest";
import type { Express } from "express";
import app from "../app";
import type { Finding } from "@workspace/db";
import type { MockState } from "./mock-repos";

// Mismo convenio que privacy-routes.test.ts: auth desactivada (el middleware
// global inyecta identidad admin simulada) y capa de repositorios sustituida
// por el stub in-memory antes de cargar `app`; PostgreSQL nunca se toca.
process.env.AUTH_DISABLED = "true";

const mocks = vi.hoisted(() => ({ state: undefined as MockState | undefined }));

function state(): MockState {
  if (!mocks.state) throw new Error("mock repos not initialized");
  return mocks.state;
}

vi.mock("../repositories", async () => {
  const { createMockRepos } = await import("./mock-repos");
  const created = createMockRepos();
  mocks.state = created.state;
  return { repos: created.repos };
});

vi.mock("@workspace/db", () => ({
  pool: { query: vi.fn() },
}));

const TODAY = () => new Date().toISOString().slice(0, 10);

/** Duplicado legacy superseded (status sigue 'open'): NO debe contar como
 * activo en ninguna métrica (regresión D8). */
function supersededDuplicate(): Finding {
  const now = new Date();
  return {
    id: "f-dup",
    title: "Duplicado legacy superseded",
    dataType: "email",
    sourceId: "src-001",
    sourceName: "Customer PostgreSQL",
    location: "public.customers.email",
    severity: "critical",
    status: "open",
    records: 10,
    detectedAt: now,
    regulation: "GDPR Art. 32",
    recommendation: "Ignorar: evidencia histórica conservada.",
    sample: "d•••@demo.com",
    scanId: null,
    lastSeenScanId: null,
    fingerprint: "fp-dup",
    firstSeenAt: now,
    lastSeenAt: now,
    superseded: true,
    createdAt: now,
    updatedAt: now,
  };
}

describe("Compliance routes", () => {
  let server: ReturnType<Express["listen"]>;

  beforeAll(() => {
    server = app.listen(0);
  });

  afterAll(() => {
    server.close();
  });

  describe("GET /api/compliance", () => {
    it("devuelve el snapshot canónico del estado mock", async () => {
      const res = await request(server).get("/api/compliance");
      expect(res.status).toBe(200);
      // Activos canónicos: f-001/f-003/f-005 (open) + f-002 (in_review) = 4;
      // f-004 está resolved y no cuenta.
      expect(res.body.openFindings).toBe(4);
      // Política 100/0 vigente (ver compliance-score.ts).
      expect(res.body.complianceScore).toBe(0);
      expect(res.body.findingsBySeverity).toEqual({
        critical: 2,
        high: 1,
        medium: 1,
        low: 0,
      });
      // 'address' queda fuera: f-004 (su único finding) está resolved.
      expect(res.body.findingsByDataType).toEqual({
        email: 1,
        national_id: 1,
        phone: 1,
        credit_card: 1,
      });
      // Sin huérfanos en el mock; empate a 1 → orden alfabético por nombre.
      expect(res.body.findingsBySource).toEqual([
        { sourceId: "src-002", sourceName: "Analytics Warehouse", openFindings: 1 },
        { sourceId: "src-003", sourceName: "CRM MySQL", openFindings: 1 },
        { sourceId: "src-001", sourceName: "Customer PostgreSQL", openFindings: 1 },
        { sourceId: "src-004", sourceName: "Payments PostgreSQL", openFindings: 1 },
      ]);
    });

    it("ignora duplicados superseded en todas las métricas (D8 vía HTTP)", async () => {
      state().findings.push(supersededDuplicate());
      const res = await request(server).get("/api/compliance");
      expect(res.status).toBe(200);
      expect(res.body.openFindings).toBe(4); // NO 5
      expect(res.body.findingsBySeverity.critical).toBe(2); // NO 3
      expect(res.body.findingsByDataType.email).toBe(1); // NO 2
    });
  });

  describe("GET /api/compliance/trend", () => {
    it("devuelve exactamente `days` puntos, oldest-first, hoy incluido", async () => {
      const res = await request(server).get("/api/compliance/trend?days=7");
      expect(res.status).toBe(200);
      expect(res.body.days).toBe(7);
      expect(res.body.points).toHaveLength(7);
      const dates = res.body.points.map((point: { date: string }) => point.date);
      expect([...dates].sort()).toEqual(dates); // ascendente
      expect(dates[dates.length - 1]).toBe(TODAY());
    });

    it("sin `days` aplica el default del contrato (30)", async () => {
      const res = await request(server).get("/api/compliance/trend");
      expect(res.status).toBe(200);
      expect(res.body.days).toBe(30);
      expect(res.body.points).toHaveLength(30);
    });

    it("acepta el límite superior del contrato (days=90)", async () => {
      const res = await request(server).get("/api/compliance/trend?days=90");
      expect(res.status).toBe(200);
      expect(res.body.days).toBe(90);
      expect(res.body.points).toHaveLength(90);
    });

    it("atribuye al bucket de hoy las altas/resoluciones/scans del día", async () => {
      const now = new Date();
      const f001 = state().findings.find((finding) => finding.id === "f-001");
      if (f001) f001.firstSeenAt = now; // alta canónica de hoy
      const f004 = state().findings.find((finding) => finding.id === "f-004");
      if (f004) f004.updatedAt = now; // resolución de hoy (f-004 está resolved)
      state().scans.push({
        id: "s-m2c",
        sourceId: "src-001",
        status: "completed",
        startedAt: now,
        completedAt: now,
        findingsCreated: 1,
        heartbeatAt: null,
        tablesScanned: 5,
        recordsRead: 1234,
        cancelRequested: false,
      });

      const res = await request(server).get("/api/compliance/trend?days=3");
      expect(res.status).toBe(200);
      const today = res.body.points[res.body.points.length - 1];
      expect(today.date).toBe(TODAY());
      expect(today.newFindings).toBe(1); // f-001 (el duplicado superseded NO cuenta)
      expect(today.resolvedFindings).toBe(1); // f-004
      expect(today.completedScans).toBe(1);
      expect(today.recordsScanned).toBe(1234);
    });

    it("rechaza days fuera de 1..90 con 400 problem+json", async () => {
      for (const days of ["0", "-1", "91", "abc", "2.5"]) {
        const res = await request(server).get(`/api/compliance/trend?days=${days}`);
        expect(res.status).toBe(400);
        expect(res.body.title).toBe("Bad Request");
      }
    });
  });
});
