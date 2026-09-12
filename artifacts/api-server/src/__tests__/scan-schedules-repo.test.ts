/**
 * M10.3 — Tests unitarios del repositorio de horarios de escaneo automático.
 *
 * Patrón real del proyecto (compliance-repo.test.ts / masking-repo.test.ts):
 * `@workspace/db` se sustituye por stubs y se ejercitan las funciones PURAS
 * exportadas por el repositorio — normalización del intervalo, cálculo de la
 * próxima corrida, criterio de vencimiento y selección de reclamables — más
 * la orquestación de `claimDue` contra un stub transaccional que replica el
 * invariante anti doble-despacho (el avance de `next_run_at` ocurre DENTRO
 * de la transacción, de modo que un segundo claim sobre el estado ya mutado
 * no devuelve nada).
 *
 * El SQL real (FOR UPDATE SKIP LOCKED, índice parcial, ON CONFLICT DO
 * UPDATE) queda cubierto por typecheck + los constraints verificados en la
 * migración 0009_flat_payback (este proyecto no tiene arnés de tests contra
 * PostgreSQL real, y añadir uno excede el alcance de M10.3).
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("@workspace/db", () => ({
  db: {
    transaction: vi.fn(),
  },
  scanSchedulesTable: {},
  sourcesTable: {},
}));

import {
  SCAN_SCHEDULE_DEFAULT_MINUTES,
  SCAN_SCHEDULE_MAX_MINUTES,
  SCAN_SCHEDULE_MIN_MINUTES,
  claimDue,
  computeNextRun,
  isDue,
  normalizeIntervalMinutes,
  selectDueSchedules,
} from "../repositories/scan-schedules.repo";

const MIN = SCAN_SCHEDULE_MIN_MINUTES; // 15
const MAX = SCAN_SCHEDULE_MAX_MINUTES; // 10080

function schedule(overrides: {
  id?: string;
  enabled?: boolean;
  intervalMinutes?: number;
  nextRunAt: Date | null;
}) {
  return {
    id: overrides.id ?? "sched-1",
    sourceId: "src-001",
    enabled: overrides.enabled ?? true,
    intervalMinutes: overrides.intervalMinutes ?? 60,
    nextRunAt: overrides.nextRunAt,
    lastRunAt: null,
    lastStatus: null,
    lastError: null,
    createdAt: new Date(0),
    updatedAt: new Date(0),
  };
}

describe("normalizeIntervalMinutes (contrato SourceScheduleUpdate)", () => {
  it("acepta los límites exactos del rango (15 y 10080)", () => {
    expect(normalizeIntervalMinutes({ enabled: true, intervalMinutes: MIN })).toEqual({
      ok: true,
      intervalMinutes: MIN,
    });
    expect(normalizeIntervalMinutes({ enabled: true, intervalMinutes: MAX })).toEqual({
      ok: true,
      intervalMinutes: MAX,
    });
  });

  it("enabled=true sin intervalo → inválido (missing_interval)", () => {
    expect(normalizeIntervalMinutes({ enabled: true })).toEqual({
      ok: false,
      reason: "missing_interval",
    });
  });

  it("enabled=false sin intervalo → default diario (1440), sin error", () => {
    expect(normalizeIntervalMinutes({ enabled: false })).toEqual({
      ok: true,
      intervalMinutes: SCAN_SCHEDULE_DEFAULT_MINUTES,
    });
  });

  it("rechaza no enteros y valores fuera de rango", () => {
    expect(normalizeIntervalMinutes({ enabled: true, intervalMinutes: 14 })).toEqual({
      ok: false,
      reason: "interval_out_of_range",
    });
    expect(normalizeIntervalMinutes({ enabled: true, intervalMinutes: 10081 })).toEqual({
      ok: false,
      reason: "interval_out_of_range",
    });
    expect(normalizeIntervalMinutes({ enabled: true, intervalMinutes: 60.5 })).toEqual({
      ok: false,
      reason: "interval_out_of_range",
    });
  });

  it("enabled=false CON intervalo fuera de rango también es inválido (no persiste basura)", () => {
    expect(normalizeIntervalMinutes({ enabled: false, intervalMinutes: 5 })).toEqual({
      ok: false,
      reason: "interval_out_of_range",
    });
  });
});

describe("computeNextRun", () => {
  it("avanza exactamente intervalMinutes minutos desde `from`", () => {
    const at = new Date("2026-01-15T10:00:00Z");
    expect(computeNextRun({ intervalMinutes: 30, from: at })).toEqual(
      new Date("2026-01-15T10:30:00Z"),
    );
  });

  it("el intervalo máximo (7 días) cruza correctamente varios días", () => {
    const at = new Date("2026-01-15T23:59:00Z");
    expect(computeNextRun({ intervalMinutes: MAX, from: at })).toEqual(
      new Date("2026-01-22T23:59:00Z"),
    );
  });
});

describe("isDue (criterio de vencimiento, frontera inclusiva)", () => {
  const now = new Date("2026-01-15T12:00:00Z");

  it("enabled + nextRunAt <= now → vencido (frontera exacta incluida)", () => {
    expect(isDue(schedule({ nextRunAt: now }), now)).toBe(true);
    expect(isDue(schedule({ nextRunAt: new Date(now.getTime() - 1) }), now)).toBe(true);
  });

  it("disabled → nunca vencido, aunque nextRunAt sea pasado", () => {
    expect(
      isDue(schedule({ enabled: false, nextRunAt: new Date(now.getTime() - 60_000) }), now),
    ).toBe(false);
  });

  it("nextRunAt null (fila en pausa) → nunca vencido", () => {
    expect(isDue(schedule({ nextRunAt: null }), now)).toBe(false);
  });

  it("nextRunAt futuro → no vencido", () => {
    expect(isDue(schedule({ nextRunAt: new Date(now.getTime() + 1) }), now)).toBe(false);
  });
});

describe("selectDueSchedules (selección pura de reclamables)", () => {
  const now = new Date("2026-01-15T12:00:00Z");

  it("filtra disabled/null/futuro y ordena por nextRunAt ASC", () => {
    const rows = [
      schedule({ id: "b", nextRunAt: new Date(now.getTime() - 60_000) }),
      schedule({ id: "a", nextRunAt: new Date(now.getTime() - 300_000) }),
      schedule({ id: "off", enabled: false, nextRunAt: new Date(now.getTime() - 900_000) }),
      schedule({ id: "null", nextRunAt: null }),
      schedule({ id: "future", nextRunAt: new Date(now.getTime() + 60_000) }),
    ];
    expect(selectDueSchedules(rows, now, 10).map((r) => r.id)).toEqual(["a", "b"]);
  });

  it("respeta el límite de despachos por tick (el más atrasado primero)", () => {
    const rows = [
      schedule({ id: "late", nextRunAt: new Date(now.getTime() - 300_000) }),
      schedule({ id: "mid", nextRunAt: new Date(now.getTime() - 120_000) }),
      schedule({ id: "near", nextRunAt: new Date(now.getTime() - 30_000) }),
    ];
    expect(selectDueSchedules(rows, now, 2).map((r) => r.id)).toEqual(["late", "mid"]);
  });

  it("sin vencidos → vacío", () => {
    expect(selectDueSchedules([], now, 5)).toEqual([]);
  });
});

describe("claimDue (orquestación transaccional anti doble-despacho)", () => {
  const now = new Date("2026-01-15T12:00:00Z");

  /** Tx stub que replica el invariante del repositorio real. */
  function makeTx(row: ReturnType<typeof schedule>) {
    let selected: ReturnType<typeof schedule>[] = [];
    return {
      select: () => ({
        from: () => ({
          where: () => ({
            orderBy: () => ({
              limit: (limit: number) => ({
                for: async () => {
                  selected =
                    row.enabled &&
                    row.nextRunAt !== null &&
                    row.nextRunAt.getTime() <= now.getTime()
                      ? [row]
                      : [];
                  return selected.slice(0, limit);
                },
              }),
            }),
          }),
        }),
      }),
      update: () => ({
        set: (patch: Record<string, unknown>) => ({
          where: () => ({
            returning: async () => {
              for (const r of selected) Object.assign(r, patch);
              return [...selected];
            },
          }),
        }),
      }),
    };
  }

  it("avanza nextRunAt DENTRO de la transacción: el segundo claim no devuelve nada", async () => {
    const row = schedule({ nextRunAt: new Date(now.getTime() - 60_000) });
    const { db } = await import("@workspace/db");
    vi.mocked(db.transaction).mockImplementation(
      async (fn: (tx: unknown) => Promise<unknown>) => fn(makeTx(row)),
    );

    const first = await claimDue({ now, limit: 5 });
    expect(first).toHaveLength(1);
    expect(row.nextRunAt!.getTime()).toBeGreaterThan(now.getTime());

    const second = await claimDue({ now, limit: 5 });
    expect(second).toEqual([]);
  });
});
