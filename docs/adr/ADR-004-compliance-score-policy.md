# ADR-004 — Politica de `complianceScore`

- **Estado**: Aceptado. Politica DEFINITIVA aprobada por producto.
- **Fecha**: 2026-09-30 (decision provisional) · ampliada a definitiva
- **Alcance**: M29.1 (Product & Demo Readiness)
- **Riesgos asociados**: ver "Riesgo de interpretacion"

## Contexto

El contrato de la API exige un `number` siempre, incluso con la base de datos
vacia:

- `Dashboard.complianceScore` (`Dashboard.complianceScore`)
- `Report.complianceScore`
- `ComplianceSummary.complianceScore`

Ese numero se muestra en el dashboard (`dashboard.tsx`), en compliance
(`compliance.tsx`) y en el shell (`app-shell.tsx`).

El calculo esta aislado en
`artifacts/api-server/src/repositories/compliance-score.ts`, que es la unica
fuente: ningun repositorio conoce el detalle del calculo.

Este ADR reforzo esa garantia: los mocks de `mock-repos.ts` dejaron de replicar
la formula a mano y delegan en `computeComplianceScore`.

## Decision

### Dominio de severidades

El dominio de un hallazgo (`FindingSeverity`) tiene **cuatro** niveles, tal y
como los fijan los contratos generados y el tipo `SeverityCounts`:

| Nivel | Peso |
| --- | --- |
| `low` | 1 |
| `medium` | 3 |
| `high` | 7 |
| `critical` | 15 |

**`info` NO forma parte del dominio actual.** No existe en el contrato zod, ni en
`SeverityCounts`, ni en la base de datos, y **no debe añadirse**.

### Formula

```text
score = max(0, 100 - (low + 3*medium + 7*high + 15*critical))
```

Donde `low`, `medium`, `high` y `critical` son los **conteos de hallazgos
ABIERTOS** por severidad.

### Reglas

1. **Cero hallazgos abiertos** -> `100`.
2. **Solo cuentan hallazgos abiertos y no superseded.** El filtro canonico es
   `activeFindingsWhere()`: `status <> 'resolved' AND superseded = false`, con
   scoping por organizacion. Los hallazgos cerrados **no participan**.
3. **El score es global por organizacion.** Se calcula una vez sobre los
   agregados de la organizacion activa.
4. **No se promedian scores por fuente.** `findingsBySource` es informativo y no
   participa del calculo.
5. **El resultado siempre esta en `[0, 100]`** gracias a `max(0, ...)`.
6. **El resultado es un entero.** Todos los pesos y conteos lo son.
7. **Un unico `critical` produce `85`**, no `0`: la severidad maxima no anula el
   score por si sola.

### Severidad desconocida

Una severidad fuera del dominio **NO** debe convertirse silenciosamente en peso
`0`. Se **rechaza en la ingesta/validacion del dato**, antes de que llegue al
dominio de scoring.

Consecuencia de diseño: `computeComplianceScore` trabaja con los cuatro conteos
validos y **no necesita decidir que hacer** ante una severidad desconocida, ni
validarla. Esa responsabilidad queda en la capa de entrada.

### Contrato

- El contrato API `complianceScore: number` **permanece sin cambios**.
- **No hay migraciones**: `reports.compliance_score` ya es `integer NOT NULL` y
  la formula devuelve un entero.

## Alternativas consideradas

| Opcion | Comportamiento | Impacto | Motivo de descarte |
| --- | --- | --- | --- |
| A. 100 / 0 (provisional, ya superada) | Score binario | Contract intacto | Descartada: `0` con cualquier hallazgo hacia que `0.0%` se leyese como "el producto no funciona" |
| **B. Ponderada por severidad (elegida)** | Score intermedio | Contract intacto | Elegida: aprobada por producto; granular sin romper el contrato |
| C. `null` / "no evaluado" | Sin score | Rompe `zod.number()` y ~6 tests | Coste alto, sin valor para la demo |
| D. Ocultar el score en la UI | Sin metrica | Cambio de producto | Reduce informacion sin resolver la duda de fondo |
| E. Promediar score por fuente | Score por fuente | Cambio de contrato | Descartada: los pesos perderian sentido al promediar y penalizaria a organizaciones fragmentadas |

## Impacto tecnico

- **Unico fichero de calculo**: `compliance-score.ts`.
- Los agregados por severidad **ya se calculan** en `compliance.repo.ts`
  (`findingsBySeverity`) y `dashboard.repo.ts` (`countsBySeverity`).
- `reports.repo.ts` requiere un `groupBy` de severidad, hoy solo pide el total.
- **Ninguna ruta, contrato OpenAPI ni consumidor de UI cambia.**
- `SeverityCounts` se reutiliza como tipo de entrada, sin tipos nuevos.

## Riesgo de interpretacion

**El score NO es un porcentaje legal de cumplimiento** y no debe presentarse
como tal. Es una medida de carga de hallazgos abiertos por severidad, no una
certificacion. Cualquier afirmacion de certificacion o cumplimiento normativo
basada en este numero seria incorrecta.

Con la formula aprobada el score pasa a ser **gradual**, lo que reduce la
ambiguedad del `0.0%` binario, pero no elimina la necesidad de explicar que el
numero no es una certificacion. La UI lo presenta como `score / 100` (por
ejemplo `87 / 100`), nunca como `%`, para no inducir la lectura de porcentaje.

## Tests de aceptacion

Estos casos gobiernan la implementacion y **ya estan implementados**: la politica
ponderada por severidad quedo aprobada definitivamente (la provisional `100 / 0`
esta descartada). Los tests de aceptacion correspondientes viven en
`artifacts/api-server/src/__tests__/compliance-score-policy.test.ts`.

| # | Entrada | Resultado esperado |
| --- | --- | --- |
| 1 | `{low:0, medium:0, high:0, critical:0}` | `100` |
| 2 | un `low` | `99` |
| 3 | un `medium` | `97` |
| 4 | un `high` | `93` |
| 5 | un `critical` | `85` |
| 6 | `{low:2, medium:1, high:0, critical:1}` | `80` |
| 7 | penalizacion exactamente `100` | `0` |
| 8 | penalizacion superior a `100` | `0` |
| 9 | hallazgos cerrados / superseded | no entran en el agregado |
| 10 | contrato API | sigue devolviendo `number` |

## Referencias

- `artifacts/api-server/src/repositories/compliance-score.ts` (unica fuente)
- `artifacts/api-server/src/repositories/compliance.repo.ts` (`SeverityCounts`,
  `activeFindingsWhere`)
- `artifacts/api-server/src/repositories/findings.repo.ts` (filtro canonico)
- `lib/api-spec/openapi.yaml` (`complianceScore: { type: number }`)
- `lib/db/src/schema/reports.ts` (`compliance_score integer NOT NULL`)