/**
 * ⚠️ POLÍTICA DE "COMPLIANCE SCORE" PENDIENTE DE DEFINICIÓN.
 *
 * El contrato de la API (`Dashboard.complianceScore` y `Report.complianceScore`)
 * exige un `number` siempre, incluso con la base de datos vacía o antes de que
 * el producto apruebe una fórmula de cumplimiento.
 *
 * Comportamiento temporal, conservador y explícito:
 *
 *   - `100` cuando NO existen hallazgos abiertos (`status <> "resolved"`):
 *     no hay incumplimientos registrados, por lo que se asume cumplimiento
 *     pleno por ausencia de evidencia en contra.
 *   - `0` cuando existe al menos un hallazgo abierto: sin una política de
 *     cálculo aprobada no se puede afirmar ningún grado de cumplimiento, así
 *     que se devuelve el valor más conservador posible en lugar de inventar
 *     un valor intermedio.
 *
 * Deliberadamente NO se replica el `94` hardcodeado de los datos demo.
 *
 * Cuando se apruebe la política real, sustituir SOLO la implementación de
 * esta función: ningún repositorio conoce el detalle del cálculo.
 */
export function computeComplianceScore({ openFindings }: { openFindings: number }): number {
  return openFindings === 0 ? 100 : 0;
}
