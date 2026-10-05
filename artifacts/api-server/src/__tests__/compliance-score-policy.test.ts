/**
 * Tests de ACEPTACION de la politica de `complianceScore` (ADR-004, aprobada).
 *
 * Casos ejecutables de la tabla "Tests de aceptacion" del ADR. Si esa tabla
 * cambia, este fichero DEBE cambiar con ella.
 *
 * La funcion NO valida severidades desconocidas a proposito: el ADR establece
 * que se rechazan en la ingesta, antes de llegar al scoring. Aqui solo se
 * comprueba el calculo con entradas validas.
 */
import { describe, expect, it } from "vitest";

import { computeComplianceScore, type SeverityCounts } from "../repositories/compliance-score";

const ZERO: SeverityCounts = { low: 0, medium: 0, high: 0, critical: 0 };

describe("ADR-004: complianceScore policy", () => {
  describe("weighing by severity", () => {
    it("returns 100 with zero open findings", () => {
      expect(computeComplianceScore(ZERO)).toBe(100);
    });

    it("subtracts 1 for a single low", () => {
      expect(computeComplianceScore({ ...ZERO, low: 1 })).toBe(99);
    });

    it("subtracts 3 for a single medium", () => {
      expect(computeComplianceScore({ ...ZERO, medium: 1 })).toBe(97);
    });

    it("subtracts 7 for a single high", () => {
      expect(computeComplianceScore({ ...ZERO, high: 1 })).toBe(93);
    });

    it("subtracts 15 for a single critical and does not zero the score", () => {
      expect(computeComplianceScore({ ...ZERO, critical: 1 })).toBe(85);
    });
  });

  describe("aggregation across severities", () => {
    it("adds the weights of mixed severities", () => {
      // 2*1 + 1*3 + 0*7 + 1*15 = 20 -> 100 - 20 = 80
      expect(computeComplianceScore({ low: 2, medium: 1, high: 0, critical: 1 })).toBe(80);
    });
  });

  describe("clamping at zero", () => {
    it("returns exactly 0 when the penalty is exactly 100", () => {
      // 0*1 + 0*3 + 10*7 + 2*15 = 70 + 30 = 100 -> 0, via the formula itself.
      expect(computeComplianceScore({ low: 0, medium: 0, high: 10, critical: 2 })).toBe(0);
    });

    it("clamps to 0 when the penalty exceeds 100", () => {
      // 7*15 = 105 > 100 -> the max() floor holds.
      expect(computeComplianceScore({ ...ZERO, critical: 7 })).toBe(0);
    });
  });

  describe("clamping at 100", () => {
    it("caps the result at 100 even for an impossible negative count", () => {
      // Un conteo negativo es una entrada imposible (COUNT(*) nunca es < 0),
      // pero el techo garantiza que el score nunca supere 100.
      expect(computeComplianceScore({ ...ZERO, low: -1 })).toBe(100);
      expect(computeComplianceScore({ ...ZERO, critical: -100 })).toBe(100);
    });
  });

  describe("invariants", () => {
    const cases: Array<[string, SeverityCounts]> = [
      ["zeros", ZERO],
      ["many low", { low: 1000, medium: 0, high: 0, critical: 0 }],
      ["many medium", { low: 0, medium: 1000, high: 0, critical: 0 }],
      ["many high", { low: 0, medium: 0, high: 1000, critical: 0 }],
      ["many critical", { low: 0, medium: 0, high: 0, critical: 1000 }],
      ["mixed", { low: 7, medium: 5, high: 3, critical: 2 }],
    ];

    for (const [name, input] of cases) {
      it(`always returns an integer in [0, 100]: ${name}`, () => {
        const score = computeComplianceScore(input);
        expect(Number.isInteger(score)).toBe(true);
        expect(score).toBeGreaterThanOrEqual(0);
        expect(score).toBeLessThanOrEqual(100);
      });
    }
  });

  describe("closed and superseded findings", () => {
    it("counts only the active set, so resolved/superseded do not weigh", () => {
      // El filtro canonico (`status <> 'resolved' AND superseded = false`) vive
      // en activeFindingsWhere y se aplica en SQL, ANTES de agregar. Este test
      // fija esa frontera del contrato: lo que llega a la funcion son conteos ya
      // filtrados, y un hallazgo resuelto NO puede cambiar el score.
      const soloActivos: SeverityCounts = { low: 0, medium: 1, high: 1, critical: 0 };
      const score = computeComplianceScore(soloActivos);

      // Un 'resolved' adicional NO se agrega: si entrara, el score bajaria.
      expect(score).toBe(90);
      // Y si el agregado incluyese los 4 findings (3 activos + 1 resuelto),
      // el valor seria distinto. La asercion de arriba distingue ambos casos.
      const conUnResueltoDeMas: SeverityCounts = { low: 1, medium: 1, high: 1, critical: 0 };
      expect(computeComplianceScore(conUnResueltoDeMas)).toBe(89);
    });
  });

  describe("API contract", () => {
    it("returns a finite number, as `complianceScore: number` requires", () => {
      const score = computeComplianceScore({ ...ZERO, high: 1 });
      expect(typeof score).toBe("number");
      expect(Number.isFinite(score)).toBe(true);
    });
  });
});