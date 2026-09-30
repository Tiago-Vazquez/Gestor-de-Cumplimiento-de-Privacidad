/**
 * M16 — Observabilidad: correlación de requests, métricas Prometheus y health
 * enriquecido.
 *
 * Cobertura:
 * - M16.1: request id generado (UUID), reutilizado del header del cliente y
 *   validado (header inválido → se regenera); propagación en la respuesta.
 * - M16.4: GET /api/metrics expone el formato Prometheus con las métricas
 *   mínimas; contador HTTP contando requests reales.
 * - M16.5: livez/readyz/healthz enriquecidos (database/scheduler) sin tocar BD
 *   en livez y fail-closed en readyz.
 * - M16.3/M16.4 (scans + scheduler): contadores end-to-end ejecutando el
 *   pipeline real (runScan/runSchedulerTick) contra repos mock (los eventos de
 *   log y las métricas se emiten desde el código de producción).
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import request from "supertest";
import type { Express } from "express";
import app from "../app";
import { pool } from "@workspace/db";
import { repos } from "../repositories";
import type { MockState } from "./mock-repos";
import {
  httpRequestDurationMs,
  httpRequestsTotal,
  metrics,
  resetMetrics,
  schedulerDispatchTotal,
  schedulerErrorsTotal,
  scansCompletedTotal,
  scansFailedTotal,
  scansStartedTotal,
} from "../lib/metrics";
import { runScan } from "../services/scanner";
import { runSchedulerTick } from "../services/scan-scheduler";

const queryMock = vi.mocked(pool.query);

const mocks = vi.hoisted(() => ({ state: undefined as MockState | undefined }));
vi.mock("@workspace/db", () => ({
  pool: { query: vi.fn(), end: vi.fn() },
}));
vi.mock("../repositories", async () => {
  const { createMockRepos } = await import("./mock-repos");
  const created = createMockRepos();
  mocks.state = created.state;
  return { repos: created.repos };
});

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

beforeEach(() => {
  queryMock.mockReset();
  queryMock.mockResolvedValue({ rows: [{ "?column?": 1 }] } as never);
  delete process.env.HEALTHCHECK_DB;
  resetMetrics();
});

describe("M16.1 — request correlation (X-Request-Id)", () => {
  let server: ReturnType<Express["listen"]>;

  beforeAll(() => {
    server = app.listen(0);
  });

  afterAll(() => {
    server.close();
  });

  it("request id generado: respuesta incluye un UUID v4 en X-Request-Id", async () => {
    const res = await request(server).get("/api/livez");
    expect(res.status).toBe(200);
    const requestId = res.headers["x-request-id"];
    expect(typeof requestId).toBe("string");
    expect(requestId).toMatch(UUID_PATTERN);
  });

  it("request id reutilizado: el header del cliente vuelve sin cambios", async () => {
    const res = await request(server)
      .get("/api/livez")
      .set("X-Request-Id", "my-correlation-id.42");
    expect(res.headers["x-request-id"]).toBe("my-correlation-id.42");
  });

  it("propagación: header inválido (espacios/salto de línea) NO se reutiliza; dos requests generan ids distintos", async () => {
    const injected = await request(server)
      .get("/api/livez")
      .set("X-Request-Id", "bad id injected");
    expect(injected.headers["x-request-id"]).toMatch(UUID_PATTERN);

    const first = await request(server).get("/api/livez");
    const second = await request(server).get("/api/livez");
    expect(first.headers["x-request-id"]).not.toBe(second.headers["x-request-id"]);
  });
});

describe("M16.4 — métricas Prometheus", () => {
  let server: ReturnType<Express["listen"]>;

  beforeAll(() => {
    server = app.listen(0);
  });

  afterAll(() => {
    server.close();
  });

  it("GET /api/metrics expone las métricas mínimas en formato Prometheus", async () => {
    const res = await request(server).get("/api/metrics");
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toContain("text/plain");
    for (const name of [
      "http_requests_total",
      "http_request_duration_ms",
      "scans_started_total",
      "scans_completed_total",
      "scans_failed_total",
      "scheduler_dispatch_total",
      "scheduler_errors_total",
      "active_scans",
    ]) {
      expect(res.text).toContain(`# TYPE ${name} `);
    }
  });

  it("contador HTTP: un request a livez queda contado con sus labels", async () => {
    expect(httpRequestsTotal.total()).toBe(0);
    await request(server).get("/api/livez");
    const res = await request(server).get("/api/metrics");
    expect(res.text).toContain('http_requests_total{method="GET",route="/api/livez",status="200"} 1');
    expect(res.text).toContain('http_request_duration_ms_count{method="GET",route="/api/livez",status="200"} 1');
  });

  it("histograma: la duración observada queda en _sum y los buckets acumulativos", async () => {
    httpRequestDurationMs.observe({ method: "GET", route: "/unit", status: "200" }, 12);
    const res = await request(server).get("/api/metrics");
    expect(res.text).toContain('http_request_duration_ms_bucket{method="GET",route="/unit",status="200",le="25"} 1');
    expect(res.text).toMatch(/http_request_duration_ms_sum\{method="GET",route="\/unit",status="200"\} \d/);
  });
});

describe("M16.5 — health endpoints enriquecidos", () => {
  let server: ReturnType<Express["listen"]>;

  beforeAll(() => {
    server = app.listen(0);
  });

  afterAll(() => {
    server.close();
  });

  it("/api/livez reporta scheduler y database unknown (no consulta BD)", async () => {
    const res = await request(server).get("/api/livez");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: "ok", database: "unknown", scheduler: "stopped" });
    expect(queryMock).not.toHaveBeenCalled();
  });

  it("/api/readyz reporta database ok cuando PostgreSQL responde", async () => {
    const res = await request(server).get("/api/readyz");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: "ok", database: "ok", scheduler: "stopped" });
  });

  it("/api/readyz fail-closed: 503 con database error cuando la BD falla", async () => {
    queryMock.mockRejectedValue(new Error("connection failed"));
    const res = await request(server).get("/api/readyz");
    expect(res.status).toBe(503);
    expect(res.body).toEqual({ status: "error", database: "error", scheduler: "stopped" });
  });
});

describe("M16.3/M16.4 — contadores de scans y scheduler (pipeline real, repos mock)", () => {
  it("runScan sobre fuente inexistente: started y failed contados, active_scans vuelve a 0", async () => {
    // Fuente inexistente en el estado mock: runScan termina source_not_found
    // vía failScanSafe (terminal único de fallo). Nunca llega a conectar.
    await runScan({ scanId: "scan-obs-1", sourceId: "src-inexistente" });
    expect(scansStartedTotal.total()).toBe(1);
    expect(scansFailedTotal.total()).toBe(1);
    const render = metrics.render();
    expect(render).toContain("scans_started_total 1");
    expect(render).toContain("scans_failed_total 1");
    expect(render).toContain("active_scans 0");
  });

  it("runSchedulerTick con vencido: scheduler_dispatch_total contado y el pipeline real arranca el scan", async () => {
    const claimDue = vi
      .spyOn(repos.scanSchedules, "claimDue")
      .mockResolvedValue([
        {
          schedule: {
            id: "sched-obs-1",
            sourceId: "src-obs-1",
            enabled: true,
            intervalMinutes: 60,
            nextRunAt: new Date(),
            lastRunAt: null,
            lastStatus: null,
            lastError: null,
            createdAt: new Date(),
            updatedAt: new Date(),
          },
        },
      ] as never);
    const startScan = vi
      .spyOn(repos.scans, "startScanInternal")
      .mockResolvedValue({ ok: true, scan: { id: "scan-obs-2" }, sourceName: "s", sourceTables: 1 } as never);

    const summary = await runSchedulerTick(new Date());
    expect(summary.dispatched).toBe(1);
    expect(schedulerDispatchTotal.total()).toBe(1);
    expect(schedulerErrorsTotal.total()).toBe(0);
    // El despacho entra al pipeline real: runScan corre en background (void),
    // así que se le da un tick al event loop antes de asertar sus contadores.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(scansStartedTotal.total()).toBe(1);
    expect(scansFailedTotal.total()).toBe(1);
    expect(startScan).toHaveBeenCalledTimes(1);
    claimDue.mockRestore();
    startScan.mockRestore();
  });

  it("runSchedulerTick con fuente ocupada: skipped sin dispatch ni error", async () => {
    const claimDue = vi
      .spyOn(repos.scanSchedules, "claimDue")
      .mockResolvedValue([
        { schedule: { id: "sched-obs-2", sourceId: "src-obs-2", enabled: true, intervalMinutes: 60 } },
      ] as never);
    const startScan = vi
      .spyOn(repos.scans, "startScanInternal")
      .mockResolvedValue({ ok: false, reason: "scan_already_running" } as never);

    const summary = await runSchedulerTick(new Date());
    expect(summary.skipped).toBe(1);
    expect(schedulerDispatchTotal.total()).toBe(0);
    expect(schedulerErrorsTotal.total()).toBe(0);
    claimDue.mockRestore();
    startScan.mockRestore();
  });

  it("runSchedulerTick con fallo del startScan: scheduler_errors_total contado", async () => {
    const claimDue = vi
      .spyOn(repos.scanSchedules, "claimDue")
      .mockResolvedValue([
        { schedule: { id: "sched-obs-3", sourceId: "src-obs-3", enabled: true, intervalMinutes: 60 } },
      ] as never);
    const startScan = vi.spyOn(repos.scans, "startScanInternal").mockRejectedValue(new Error("db down"));

    const summary = await runSchedulerTick(new Date());
    expect(summary.failed).toBe(1);
    expect(schedulerDispatchTotal.total()).toBe(0);
    expect(schedulerErrorsTotal.total()).toBe(1);
    claimDue.mockRestore();
    startScan.mockRestore();
  });

  it("completed: el contador acumula y el render lo expone", () => {
    scansCompletedTotal.inc();
    scansCompletedTotal.inc();
    expect(scansCompletedTotal.total()).toBe(2);
    expect(metrics.render()).toContain("scans_completed_total 2");
  });
});