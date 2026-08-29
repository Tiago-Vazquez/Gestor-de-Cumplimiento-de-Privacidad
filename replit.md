# Privacy Compliance Manager

Consola de cumplimiento que monitorea fuentes de datos, detecta información sensible expuesta y prepara datos anonimizados para testing.

## Run & Operate

- `pnpm --filter @workspace/api-server run dev` — run the API server (port 5000)
- `pnpm run typecheck` — full typecheck across all packages
- `pnpm run build` — typecheck + build all packages
- `pnpm --filter @workspace/api-spec run codegen` — regenerate API hooks and Zod schemas from the OpenAPI spec
- `pnpm --filter @workspace/db run push` — push DB schema changes (dev only)
- Required env: `DATABASE_URL` — Postgres connection string

## Stack

- pnpm workspaces, Node.js 24, TypeScript 5.9
- API: Express 5
- DB: PostgreSQL + Drizzle ORM
- Validation: Zod (`zod/v4`), `drizzle-zod`
- API codegen: Orval (from OpenAPI spec)
- Build: esbuild (CJS bundle)

## Where things live

- `artifacts/privacy-compliance-manager/src/` — aplicación web y páginas del panel.
- `artifacts/api-server/src/routes/privacy.ts` — endpoints y datos operativos de demo.
- `lib/api-spec/openapi.yaml` — contrato de API fuente de verdad.
- `lib/api-client-react/src/generated/` — hooks React Query generados por Orval.

## Architecture decisions

- La interfaz consume exclusivamente hooks generados desde OpenAPI para mantener alineados cliente y servidor.
- El dashboard se actualiza mediante consultas del servidor y las mutaciones invalidan sus listas relacionadas.
- Los escaneos exponen un flujo `running` → `completed` y agregan actividad para que la consola refleje operaciones en curso.
- El primer corte usa datos de demostración seguros en memoria; las fuentes reales deben conectarse detrás de la misma API.

## Product

- Dashboard con puntuación de cumplimiento, hallazgos abiertos, riesgo por severidad y actividad reciente.
- Hallazgos filtrables con detalle, recomendación y actualización de estado.
- Fuentes monitoreadas con acción de escaneo manual.
- Catálogo de reglas de detección, preview de anonimización y generación de informes.

## User preferences

- Responder siempre en español.

## Gotchas

- Después de cambiar `lib/api-spec/openapi.yaml`, ejecutar `pnpm --filter @workspace/api-spec run codegen`.
- El servicio API corre bajo `/api`; la interfaz usa el prefijo base del artefacto y no URLs localhost.

## Pointers

- See the `pnpm-workspace` skill for workspace structure, TypeScript setup, and package details
