/**
 * M10.4 — Tests del scheduler de escaneos automáticos.
 *
 * Patrón del proyecto: mocks de la capa `repos` (sin PostgreSQL) y del
 * pipeline `runScan`, verificando la orquestación del tick, la guardia contra
 * ticks concurrentes, el ciclo start/stop y el comportamiento ante horarios
 * atrasados (sin catch-up storm).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

process.env.AUTH_DISABLED = "false";

vi.mock("../repositories", () => ({
  repos: {
    scanSchedules: { claimDue: vi.fn(), markResult: vi.fn() },
    scans: { startScanInternal: vi.fn() },
  },
}));
vi.mock("../services/scanner", () => ({
  runScan: vi.fn().mockResolvedValue(undefined),
}));

import { repos } from "../repositories";
import { runScan } from "../services/scanner";
import {
  runSchedulerTick,
  runSchedulerTickSafely,
  startScanScheduler,
  stopScanScheduler,
  scanSchedulerBatch,
  scanSchedulerTickMs,
} from "../services/scan-scheduler";

const mockedClaimDue = vi.mocked(repos.scanSchedules.claimDue);
const mockedMarkResult = vi.mocked(repos.scanSchedules.markResult);
const mockedStartScan = vi.mocked(repos.scans.startScanInternal);
const mockedRunScan = vi.mocked(runScan);

const now = new Date("2026-01-15T12:00:00Z");

function schedule(overrides: Partial<{ id: string; sourceId: string; intervalMinutes: number }> = {}) {
  return {
    id: overrides.id ?? "sched-1",
    sourceId: overrides.sourceId ?? "src-1",
    enabled: true,
    intervalMinutes: overrides.intervalMinutes ?? 60,
    nextRunAt: now,
    lastRunAt: null,
    lastStatus: null,
    lastError: null,
    createdAt: now,
    updatedAt: now,
  };
}

beforeEach(() => {
  stopScanScheduler();
});

afterEach(() => {
  stopScanScheduler();
});

describe("runSchedulerTick (orquestación del tick)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("sin schedules vencidos → no despacha ni marca resultados", async () => {
    mockedClaimDue.mockResolvedValue([]);

    const summary = await runSchedulerTick(now);

    expect(summary).toEqual({ claimed: 0, dispatched: 0, skipped: 0, failed: 0 });
    expect(mockedStartScan).not.toHaveBeenCalled();
    expect(mockedRunScan).not.toHaveBeenCalled();
    expect(mockedMarkResult).not.toHaveBeenCalled();
  });

  it("un schedule vencido → despacha por el pipeline estándar y marca ok", async () => {
    const row = schedule();
    mockedClaimDue.mockResolvedValue([{ schedule: row }]);
    mockedStartScan.mockResolvedValue({
      ok: true,
      scan: { id: "scan-1" } as never,
      sourceName: "db",
      sourceTables: 1,
    });

    const summary = await runSchedulerTick(now);

    expect(summary).toEqual({ claimed: 1, dispatched: 1, skipped: 0, failed: 0 });
    expect(mockedStartScan).toHaveBeenCalledWith({ sourceId: row.sourceId, startedAt: now });
    expect(mockedMarkResult).toHaveBeenCalledWith({ id: row.id, status: "ok", at: now });
    expect(mockedRunScan).toHaveBeenCalledWith({ scanId: "scan-1", sourceId: row.sourceId });
  });

  it("source con scan ya en curso → markResult skipped, sin runScan", async () => {
    const row = schedule();
    mockedClaimDue.mockResolvedValue([{ schedule: row }]);
    mockedStartScan.mockResolvedValue({ ok: false, reason: "scan_already_running" });

    const summary = await runSchedulerTick(now);

    expect(summary).toEqual({ claimed: 1, dispatched: 0, skipped: 1, failed: 0 });
    expect(mockedMarkResult).toHaveBeenCalledWith({ id: row.id, status: "skipped", at: now });
    expect(mockedRunScan).not.toHaveBeenCalled();
  });
});

describe("varios despachos y fallos en un tick", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("varios schedules vencidos → despacha todos en el mismo tick", async () => {
    const rows = [
      schedule({ id: "s1", sourceId: "src-1" }),
      schedule({ id: "s2", sourceId: "src-2" }),
    ];
    mockedClaimDue.mockResolvedValue(rows.map((row) => ({ schedule: row })));
    mockedStartScan.mockResolvedValue({
      ok: true,
      scan: { id: "scan-x" } as never,
      sourceName: "db",
      sourceTables: 1,
    });

    const summary = await runSchedulerTick(now);

    expect(summary).toEqual({ claimed: 2, dispatched: 2, skipped: 0, failed: 0 });
    expect(mockedStartScan).toHaveBeenCalledTimes(2);
    expect(mockedRunScan).toHaveBeenCalledTimes(2);
  });

  it("fallo de un despacho → markResult error y NO detiene el resto del tick", async () => {
    const rows = [
      schedule({ id: "s1", sourceId: "src-1" }),
      schedule({ id: "s2", sourceId: "src-2" }),
    ];
    mockedClaimDue.mockResolvedValue(rows.map((row) => ({ schedule: row })));
    mockedStartScan
      .mockRejectedValueOnce(new Error("db down"))
      .mockResolvedValueOnce({
        ok: true,
        scan: { id: "scan-2" } as never,
        sourceName: "db",
        sourceTables: 1,
      });

    const summary = await runSchedulerTick(now);

    expect(summary).toEqual({ claimed: 2, dispatched: 1, skipped: 0, failed: 1 });
    expect(mockedMarkResult).toHaveBeenCalledWith({
      id: "s1",
      status: "error",
      error: "db down",
      at: now,
    });
    // El despacho fallido no llegó a arrancar un scan: runScan solo para s2.
    expect(mockedRunScan).toHaveBeenCalledTimes(1);
    expect(mockedRunScan).toHaveBeenCalledWith({ scanId: "scan-2", sourceId: "src-2" });
  });
});

describe("start/stop del scheduler (lifecycle)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
  });

  afterEach(() => {
    stopScanScheduler();
    vi.useRealTimers();
  });

  it("start crea un único timer aunque se llame varias veces", () => {
    startScanScheduler();
    startScanScheduler();
    startScanScheduler();

    expect(vi.getTimerCount()).toBe(1);
  });

  it("stop limpia el timer: no hay más ticks después", async () => {
    mockedClaimDue.mockResolvedValue([]);

    startScanScheduler();
    stopScanScheduler();
    await vi.advanceTimersByTimeAsync(10 * 60_000);

    expect(vi.getTimerCount()).toBe(0);
    expect(mockedClaimDue).not.toHaveBeenCalled();
  });

  it("stop sin start es un no-op seguro", () => {
    expect(() => stopScanScheduler()).not.toThrow();
  });

  it("un fallo del claim no detiene el scheduler (sigue en el siguiente tick)", async () => {
    mockedClaimDue.mockRejectedValueOnce(new Error("boom")).mockResolvedValue([]);

    startScanScheduler();

    await vi.advanceTimersByTimeAsync(60_000); // tick 1: falla (capturado)
    await vi.advanceTimersByTimeAsync(60_000); // tick 2: sigue vivo
    expect(mockedClaimDue).toHaveBeenCalledTimes(2);
    expect(mockedClaimDue).toHaveBeenLastCalledWith({ now: expect.any(Date), limit: 5 });
  });
});

describe("guardia contra ticks concurrentes", () => {
  it("si un tick está en curso, el siguiente se salta (no se solapan)", async () => {
    vi.clearAllMocks();

    let releaseClaim!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseClaim = resolve;
    });
    mockedClaimDue.mockImplementationOnce(async () => {
      await gate; // tick 1 "colgado" dentro del claim
      return [];
    });

    const first = runSchedulerTickSafely();
    const second = runSchedulerTickSafely(); // debe ser un no-op

    releaseClaim();
    await Promise.all([first, second]);

    // El segundo tick no llegó a reclamar: la guardia lo bloqueó.
    expect(mockedClaimDue).toHaveBeenCalledTimes(1);
  });
});

describe("horario atrasado por downtime (sin catch-up storm)", () => {
  it("un atraso grande produce UN solo dispatch y nextRunAt queda en el futuro", async () => {
    vi.clearAllMocks();
    // Downtime de 3 días: el schedule venció hace 3 días con intervalo diario.
    const late = schedule({ intervalMinutes: 1440 });
    late.nextRunAt = new Date(now.getTime() - 3 * 24 * 60 * 60_000);
    // El stub replica el invariante del claim real: avanza next_run_at desde
    // `now` DENTRO de la transacción (una corrida, sin catch-up).
    mockedClaimDue.mockImplementationOnce(async () => {
      late.nextRunAt = new Date(now.getTime() + late.intervalMinutes * 60_000);
      return [{ schedule: late }];
    });
    mockedStartScan.mockResolvedValue({
      ok: true,
      scan: { id: "scan-late" } as never,
      sourceName: "db",
      sourceTables: 1,
    });

    const summary = await runSchedulerTick(now);

    expect(summary).toEqual({ claimed: 1, dispatched: 1, skipped: 0, failed: 0 });
    expect(mockedStartScan).toHaveBeenCalledTimes(1);
    expect(late.nextRunAt.getTime()).toBe(now.getTime() + 1440 * 60_000);
    expect(late.nextRunAt.getTime()).toBeGreaterThan(now.getTime());
  });
});

describe("configuración por variables de entorno", () => {
  afterEach(() => {
    delete process.env.SCAN_SCHEDULER_TICK_MS;
    delete process.env.SCAN_SCHEDULER_BATCH;
  });

  it("defaults razonables sin env: 60 s y 5 por tick", () => {
    expect(scanSchedulerTickMs()).toBe(60_000);
    expect(scanSchedulerBatch()).toBe(5);
  });

  it("clamps de seguridad: tick [10 s, 1 h], batch [1, 50]", () => {
    process.env.SCAN_SCHEDULER_TICK_MS = "1000";
    expect(scanSchedulerTickMs()).toBe(10_000);
    process.env.SCAN_SCHEDULER_TICK_MS = "999999999";
    expect(scanSchedulerTickMs()).toBe(3_600_000);
    process.env.SCAN_SCHEDULER_TICK_MS = "garbage";
    expect(scanSchedulerTickMs()).toBe(60_000);

    process.env.SCAN_SCHEDULER_BATCH = "100";
    expect(scanSchedulerBatch()).toBe(50);
    // Valor inválido (0) → fallback al default, mismo criterio que el reaper.
    process.env.SCAN_SCHEDULER_BATCH = "0";
    expect(scanSchedulerBatch()).toBe(5);
    process.env.SCAN_SCHEDULER_BATCH = "7";
    expect(scanSchedulerBatch()).toBe(7);
  });
});