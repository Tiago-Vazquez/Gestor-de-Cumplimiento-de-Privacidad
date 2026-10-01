/**
 * Politica de `complianceScore` (ADR-004, aprobada por producto).
 *
 * El calculo vive aqui y en ningun otro sitio: los repositorios resumen
 * severidades a esta funcion sin conocer los pesos.
 *
 * ## Pesos
 *
 * | Nivel      | Peso |
 * | ---------- | ---- |
 * | `low`      | 1    |
 * | `medium`   | 3    |
 * | `high`     | 7    |
 * | `critical` | 15   |
 *
 * ## Formula
 *
 *     score = max(0, 100 - (low + 3*medium + 7*high + 15*critical))
 *
 * Los conteos son de hallazgos ABIERTOS por severidad. `info` NO forma parte
 * del dominio y no debe anadirse.
 *
 * ## Reglas
 *
 * - Cero hallazgos abiertos -> `100`.
 * - El score es global por organizacion; no se promedia por fuente.
 * - El resultado es un entero siempre dentro de `[0, 100]`.
 * - Un unico `critical` produce `85`, no `0`.
 *
 * ## Severidad desconocida
 *
 * NO se valida aqui a proposito: el ADR establece que una severidad fuera del
 * dominio se rechaza en la INGESTA, antes de llegar al scoring. Esta funcion
 * asume entradas validas y no decide que hacer con una invalida; validarla
 * duplicaria esa responsabilidad y permitiria que un endpoint de lectura
 * fallara por un dato sucio.
 */
export type SeverityCounts = { critical: number; high: number; medium: number; low: number };

/** Pesos por severidad (ADR-004). La clave es el dominio: no hay `info`. */
const SEVERITY_WEIGHT = {
  low: 1,
  medium: 3,
  high: 7,
  critical: 15,
} as const satisfies Record<keyof SeverityCounts, number>;

export function computeComplianceScore(counts: SeverityCounts): number {
  const penalty = (Object.keys(SEVERITY_WEIGHT) as Array<keyof SeverityCounts>).reduce(
    (total, severity) => total + counts[severity] * SEVERITY_WEIGHT[severity],
    0,
  );
  return Math.max(0, 100 - penalty);
}