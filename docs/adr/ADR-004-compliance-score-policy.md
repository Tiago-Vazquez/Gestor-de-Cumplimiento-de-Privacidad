# ADR-004 — Politica de `complianceScore` (PROVISIONAL)

- **Estado**: Aceptado, con decision provisional explicita
- **Fecha**: 2026-09-30
- **Alcance**: M29.1 (Product & Demo Readiness)
- **Riesgos asociados**: R2 (atenuado, no cerrado)

## Contexto

El contrato de la API exige un `number` siempre, incluso con la base de datos
vacia o antes de que el producto apruebe una formula de cumplimiento:

- `Dashboard.complianceScore` (`Dashboard.complianceScore`)
- `Report.complianceScore`
- `ComplianceSummary.complianceScore`

Ese numero se muestra en el dashboard (`dashboard.tsx`), en compliance
(`compliance.tsx`) y en el shell (`app-shell.tsx`).

Hoy NO existe una politica de scoring aprobada. El calculo esta aislado en
`artifacts/api-server/src/repositories/compliance-score.ts`, que es la unica
fuente: ningun repositorio conoce el detalle del calculo.

## Decision

**Se mantiene la politica provisional actual, de forma explicita:**

```ts
export function computeComplianceScore({ openFindings }: { openFindings: number }): number {
  return openFindings === 0 ? 100 : 0;
}
```

- `100` cuando no hay hallazgos abiertos (`status <> "resolved"`).
- `0` cuando existe al menos un hallazgo abierto.

No se introduce formula ponderada, no se introduce `null`, no se oculta el
valor y no se cambia el contrato de la API.

## Por que NO se introduce todavia una formula ponderada

Ponderar por severidad exige decidir el peso de cada nivel y como se agrega a
nivel de organizacion. Esa es una **decision de producto**, no tecnica: el
repositorio la tiene marcada como pendiente desde su creacion y nadie la ha
resuelto. Fijarla aqui convertiria una suposicion del equipo de ingenieria en
una "metodologia de cumplimiento" sin respaldo, que es justo lo que este ADR
evita.

## Alternativas consideradas

| Opcion | Comportamiento | Impacto | Motivo de descarte |
| --- | --- | --- | --- |
| **A. 100 / 0 (elegida)** | Score binario | Contract intacto, 0 aserciones tocadas | Se mantiene; es explicito y no inventa granularidad |
| B. Ponderada por severidad | Score intermedio | Cambia semantica de API y UI | Requiere politica de producto; ADR-002/003 no la definen |
| C. `null` / "no evaluado" | Sin score | Rompe `zod.number()` y ~6 tests | Coste alto, sin valor para la demo |
| D. Ocultar el score en la UI | Sin metrica | Cambio de producto | Reduce informacion sin resolver la duda de fondo |

## Impacto de la opcion A (lo que hay que saber)

- El dashboard muestra `100.0%` o `0.0%`. Nunca un valor intermedio.
- Con hallazgos abiertos, la tarjeta muestra `0.0%`. Puede leerse como
  "el producto no funciona" en lugar de "no hay politica aprobada".
- `replit.md` documenta que la politica definitiva queda pendiente de
  aprobacion de producto.

## Riesgo de interpretacion

**El score NO es un porcentaje legal de cumplimiento** y no debe presentarse
como tal. Mide unicamente "hay o no hay hallazgos abiertos". Cualquier
afirmacion de certificacion o cumplimiento normativo basada en este numero
seria incorrecta.

## Que falta para convertirla en politica definitiva

1. Definir la ponderacion por severidad (info/low/medium/high/critical).
2. Definir la agregacion a nivel de organizacion.
3. Aprobar la politica como producto.
4. Cambiar **solo** la implementacion de `computeComplianceScore`; ningun
   repositorio ni consumidor necesita cambios (por diseño, ver el ADR).

Los pasos 1-3 son de producto y quedan FUERA de M29.1.

## Referencias

- `artifacts/api-server/src/repositories/compliance-score.ts` (unica fuente)
- `replit.md` (politica pendiente de aprobacion)
- `docs/adr/ADR-002-m25-0-backup-and-dr-architecture.md` (R2)