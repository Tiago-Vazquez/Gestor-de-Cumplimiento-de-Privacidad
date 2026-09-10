import { describe, expect, it } from "vitest";
import {
  UTC_MS_PER_DAY,
  buildTrendDayKeys,
  buildTrendPoints,
  utcDayKey,
  utcDayStart,
} from "../lib/trend-buckets";

/** Referencia fija (mediodía UTC) para tests deterministas. */
const NOW = new Date("2026-03-15T12:00:00.000Z");

describe("utcDayKey", () => {
  it("devuelve YYYY-MM-DD en UTC, no en la zona local del proceso", () => {
    // 21:00-05:00 == 02:00Z del día siguiente.
    expect(utcDayKey(new Date("2026-03-15T21:00:00-05:00"))).toBe("2026-03-16");
    expect(utcDayKey(new Date("2026-03-15T23:59:59.999Z"))).toBe("2026-03-15");
    expect(utcDayKey(new Date("2026-03-16T00:00:00.000Z"))).toBe("2026-03-16");
  });
});

describe("utcDayStart", () => {
  it("devuelve la medianoche UTC exacta de la clave", () => {
    expect(utcDayStart("2026-03-15").toISOString()).toBe("2026-03-15T00:00:00.000Z");
  });
});

describe("buildTrendDayKeys", () => {
  it("devuelve exactamente `days` claves, la más antigua primero, hoy incluido", () => {
    expect(buildTrendDayKeys(1, NOW)).toEqual(["2026-03-15"]);
    expect(buildTrendDayKeys(3, NOW)).toEqual(["2026-03-13", "2026-03-14", "2026-03-15"]);
  });

  it("cruza los límites de mes y de año con aritmética UTC correcta", () => {
    expect(buildTrendDayKeys(5, new Date("2026-03-02T08:00:00.000Z"))).toEqual([
      "2026-02-26",
      "2026-02-27",
      "2026-02-28",
      "2026-03-01",
      "2026-03-02",
    ]);
    expect(buildTrendDayKeys(5, new Date("2026-01-03T08:00:00.000Z"))).toEqual([
      "2025-12-30",
      "2025-12-31",
      "2026-01-01",
      "2026-01-02",
      "2026-01-03",
    ]);
  });

  it("para days=90 cubre exactamente 90 días que terminan hoy", () => {
    const keys = buildTrendDayKeys(90, NOW);
    expect(keys).toHaveLength(90);
    expect(keys[0]).toBe("2025-12-16");
    expect(keys[keys.length - 1]).toBe("2026-03-15");
  });

  it("no depende de la hora del request (trunca al día UTC)", () => {
    const early = buildTrendDayKeys(2, new Date("2026-03-15T00:00:00.001Z"));
    const late = buildTrendDayKeys(2, new Date("2026-03-15T23:59:59.999Z"));
    expect(early).toEqual(late);
  });

  it("rechaza days no enteros o menores que 1", () => {
    for (const invalid of [0, -3, 2.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => buildTrendDayKeys(invalid, NOW)).toThrow(RangeError);
    }
  });

  it("usa el día UTC de `now`, no el local (ventana estable en cualquier TZ)", () => {
    // 2026-03-15T23:30-03:00 == 2026-03-16T02:30Z.
    const keys = buildTrendDayKeys(1, new Date("2026-03-15T23:30:00-03:00"));
    expect(keys).toEqual(["2026-03-16"]);
  });

  it("expone UTC_MS_PER_DAY coherente con la aritmética interna", () => {
    expect(UTC_MS_PER_DAY).toBe(24 * 60 * 60 * 1000);
  });
});

describe("buildTrendPoints", () => {
  const KEYS = ["2026-03-13", "2026-03-14", "2026-03-15"];

  it("genera un punto por clave, cero-incluido y en orden", () => {
    const points = buildTrendPoints({
      dayKeys: KEYS,
      newFindings: [],
      resolvedFindings: [],
      completedScans: [],
    });
    expect(points).toEqual([
      { date: "2026-03-13", newFindings: 0, resolvedFindings: 0, completedScans: 0, recordsScanned: 0 },
      { date: "2026-03-14", newFindings: 0, resolvedFindings: 0, completedScans: 0, recordsScanned: 0 },
      { date: "2026-03-15", newFindings: 0, resolvedFindings: 0, completedScans: 0, recordsScanned: 0 },
    ]);
  });

  it("atribuye cada evento a su día UTC y acumula varios del mismo día", () => {
    const points = buildTrendPoints({
      dayKeys: KEYS,
      newFindings: [
        { at: new Date("2026-03-14T10:00:00.000Z") },
        { at: new Date("2026-03-14T22:00:00.000Z") },
        { at: new Date("2026-03-15T01:00:00.000Z") },
      ],
      resolvedFindings: [{ at: new Date("2026-03-13T18:00:00.000Z") }],
      completedScans: [],
    });
    expect(points.map((p) => p.newFindings)).toEqual([0, 2, 1]);
    expect(points.map((p) => p.resolvedFindings)).toEqual([1, 0, 0]);
  });

  it("suma recordsRead de los scans completados del día", () => {
    const points = buildTrendPoints({
      dayKeys: KEYS,
      newFindings: [],
      resolvedFindings: [],
      completedScans: [
        { at: new Date("2026-03-14T09:00:00.000Z"), recordsRead: 100 },
        { at: new Date("2026-03-14T15:00:00.000Z"), recordsRead: 250 },
        { at: new Date("2026-03-15T09:00:00.000Z"), recordsRead: 7 },
      ],
    });
    expect(points.map((p) => p.completedScans)).toEqual([0, 2, 1]);
    expect(points.map((p) => p.recordsScanned)).toEqual([0, 350, 7]);
  });

  it("descarta eventos fuera de la ventana y con `at` nulo", () => {
    const points = buildTrendPoints({
      dayKeys: KEYS,
      newFindings: [
        { at: new Date("2026-03-12T23:59:59.999Z") }, // antes de la ventana
        { at: new Date("2026-03-16T00:00:00.000Z") }, // después de la ventana
        { at: null },
      ],
      resolvedFindings: [{ at: null }],
      completedScans: [{ at: null, recordsRead: 5000 }],
    });
    expect(points.every((p) => p.newFindings === 0 && p.resolvedFindings === 0 && p.recordsScanned === 0)).toBe(true);
  });
});
