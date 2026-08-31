@ Privacy Compliance Manager

Consola de cumplimiento que monitorea fuentes de datos, detecta información sensible expuesta y prepara datos anonimizados para testing.

## Run & Operate

- `pnpm --filter @workspace/api-server run dev` — run the API server (port 5000)
- `pnpm run typecheck` — full typecheck across all packages
- `pnpm run build` — typecheck + build all packages
- `pnpm --filter @workspace/api-spec run codegen` — regenerate API hooks and Zod schemas from the OpenAPI spec
- `pnpm --filter @workspace/db run db:generate` — generate a Drizzle migration after schema changes; review the generated SQL under `lib/db/drizzle/` before committing
- `pnpm --filter @workspace/db run db:migrate` — apply pending Drizzle migrations to PostgreSQL (idempotent; also run by post-merge)
- Required env: `DATABASE_URL` — Postgres connection string
- Optional env (API): `CORS_ORIGINS` (comma-separated allowlist; unset in production = same-origin only, in dev defaults to the local Vite ports), `TRUST_PROXY` (default `1`, Replit router hop), `RATE_LIMIT_WINDOW_MS` (default `60000`), `RATE_LIMIT_MAX` (default `100`), `RATE_LIMIT_MUTATIONS_MAX` (default `30`), `JSON_BODY_LIMIT` (default `16kb`)

## Stack

- pnpm workspaces, Node.js 24, TypeScript 5.9
- API: Express 5
- DB: PostgreSQL + Drizzle ORM — persistencia real, sin datos demo en memoria
- Validation: Zod (`zod/v4`), `drizzle-zod`
- API codegen: Orval (from OpenAPI spec)
- Build: esbuild (CJS bundle)

## Where things live

- `artifacts/privacy-compliance-manager/src/` — aplicación web y páginas del panel.
- `artifacts/api-server/src/routes/privacy.ts` — endpoints de privacidad (handlers async finos).
- `artifacts/api-server/src/repositories/` — capa de repositorios, único punto de acceso a `@workspace/db`; `compliance-score.ts` aísla la política del compliance score.
- `artifacts/api-server/src/mappers.ts` — mapeo fila BD → contratos Zod (OpenAPI intacto).
- `lib/db/src/schema/` — esquema Drizzle (sources, findings, rules, scans, activity, reports).
- `lib/db/drizzle/` — migraciones SQL versionadas y snapshot (revisar el SQL antes de aplicar).
- `lib/api-spec/openapi.yaml` — contrato de API fuente de verdad.
- `lib/api-client-react/src/generated/` — hooks React Query generados por Orval.

## Architecture decisions

- La interfaz consume exclusivamente hooks generados desde OpenAPI para mantener alineados cliente y servidor.
- El dashboard se actualiza mediante consultas del servidor y las mutaciones invalidan sus listas relacionadas.
- Los escaneos exponen un flujo `running` → `completed`; la finalización se persiste en PostgreSQL (transacción con actividad).
- Persistencia real en PostgreSQL: los handlers llaman a repositorios (`repos`) y las mutaciones multi-tabla usan transacciones; los arrays demo en memoria fueron eliminados y NO existe seed automático — la BD arranca sin datos y todo dato se crea por la API o por el negocio.
- Migraciones: flujo `db:generate` → revisión del SQL → commit → `db:migrate` (idempotente, también en post-merge). No se usa `drizzle-kit push` contra entornos con datos por ser potencialmente destructivo.
- Estado de la migración: `0000_fancy_xorn` (CREATE-only, 6 tablas) aplicada en la BD local `privacy_compliance`; tablas con 0 filas.
- `complianceScore` aislado en `repositories/compliance-score.ts`: 100 sin hallazgos abiertos, 0 con alguno; la política definitiva queda pendiente de aprobación de producto.

## Product

- Dashboard con puntuación de cumplimiento, hallazgos abiertos, riesgo por severidad y actividad reciente.
- Hallazgos filtrables con detalle, recomendación y actualización de estado.
- Fuentes monitoreadas con acción de escaneo manual.
- Catálogo de reglas de detección, preview de anonimización y generación de informes.

## User preferences

- Responder siempre en español.

## Gotchas

- Después de cambiar `lib/api-spec/openapi.yaml`, ejecutar `pnpm --filter @workspace/api-spec run codegen`.
- Después de cambiar `lib/db/src/schema/`, ejecutar `pnpm --filter @workspace/db run db:generate` y revisar el SQL antes de commitear.
- El servicio API corre bajo `/api`; la interfaz usa el prefijo base del artefacto y no URLs localhost.

## Pointers

- See the `pnpm-workspace` skill for workspace structure, TypeScript setup, and package details
