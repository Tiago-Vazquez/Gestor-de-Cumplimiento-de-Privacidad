# Gestor de Cumplimiento de Privacidad

Plataforma de **escaneo de privacidad sobre fuentes de datos reales**: conectores
a PostgreSQL y MySQL que recorren el esquema y las filas, detectan datos
personales (PII), y producen hallazgos con huella estable que sobreviven a
ciclos de backup y restore.

El problema que resuelve: una organizacion no puede saber si sus bases de datos
guardan PII, ni demostrarlo ante una auditoria, ni tener certeza de que sus
copias de seguridad restauran los mismos datos que las respaldaron.

> **Estado**: demo-ready / en preparacion de piloto. **No** es produccion.
> Vease [Limitaciones](#limitaciones-conocidas).

## Arquitectura

```
Usuario
  |
  v
Frontend React (Vite + wouter)  artifacts/privacy-compliance-manager
  |  api-client-react: fetch + cabecera CSRF
  v
API Express                        artifacts/api-server
  |  helmet -> CORS allowlist -> requireAuth (JWT + allowlist de sesiones)
  |  org-context (resolucion de tenant) -> rutas por dominio
  v
Repositorios (tenant scoping)  ->  pool PostgreSQL con app_role NOBYPASSRLS
  |                                     RLS: app.current_tenant (fail-closed)
  v
PostgreSQL 16  +  Drizzle ORM  (migraciones 0000-0019)
```

Conectores: `postgres`, `mysql` (`artifacts/api-server/src/connectors/`).
El motor de escaneo (`services/scanner.ts`) corre sobre un scheduler con latido
(heartbeat) y recuperacion de escaneos abandonados.

## Modulos funcionales

| Modulo | Que hace |
| --- | --- |
| **Fuentes** | CRUD de conexiones, con la configuracion cifrada (AES-256-GCM) |
| **Conectores** | PostgreSQL y MySQL: listar tablas, esquema, muestreo de filas |
| **Escaneo** | Motor que recorre la fuente y genera hallazgos con huella estable |
| **Findings** | Ciclo de vida completo (detalle, filtros, resolved/open) |
| **Reglas** | Reglas de compliance y sus efectos |
| **Masking** | Anonimizacion determinista y descarga del dataset resultante |
| **Reports / Compliance** | Informes periodicos y resumen de cumplimiento |
| **Dashboard** | Metricas agregadas de la organizacion |
| **Auditoria** | Trail de auditoria con actor, recurso y resultado |
| **Organizaciones** | Tenants, membresias e invitaciones |
| **Usuarios y roles** | Identidades locales, roles `admin` / `auditor` |
| **Sesiones** | Listado, revocacion, cierre masivo, expiracion por inactividad |

## Quick Start

### Requisitos

- Node.js >= 22.22.2
- pnpm 10.18.3 (fijado en `packageManager`)
- PostgreSQL 16 (local o Docker)

### Instalacion

```bash
pnpm install
```

### Configuracion

```bash
cp .env.example .env
```

Complete como minimo `POSTGRES_PASSWORD`, `JWT_SECRET` y
`SOURCE_ENCRYPTION_KEY` (los tres exigen **>= 32 caracteres**). Consulte
`.env.example` para la lista completa de variables.

### Migraciones

```bash
pnpm --filter @workspace/db run db:migrate
```

### Primer usuario administrador

```bash
PROVISION_ADMIN_EMAIL=admin@ejemplo.com \
PROVISION_ADMIN_PASSWORD='<>=32 chars>' \
pnpm --filter @workspace/db run db:provision-admin
```

Crea organizacion + administrador + rol global, de forma **idempotente**
(organizacion por id deterministico, usuario por email, `ON CONFLICT DO
NOTHING`). La contrasena viaja **solo** por variable de entorno.

### Arranque

```bash
docker compose up -d          # Postgres + migraciones + API + web
```

O en desarrollo:

```bash
pnpm --filter @workspace/api-server run dev     # API en :5000
pnpm --filter @workspace/privacy-compliance-manager run dev   # web en :5173
```

### Health checks

```bash
curl -s http://localhost:5000/api/livez     # vivo
curl -s http://localhost:5000/api/readyz    # listo (requiere DB)
curl -s http://localhost:5000/api/metrics   # metricas Prometheus
```

## Desarrollo

| Comando | Que hace |
| --- | --- |
| `pnpm run typecheck:libs` | Typecheck de librerias compartidas |
| `pnpm run typecheck:product` | Typecheck de API y frontend |
| `pnpm run build:product` | Build de API y frontend |
| `pnpm run test:product` | Tests de API y frontend |
| `pnpm run test:ops` | Tests de scripts operativos (offline) |
| `pnpm run audit:high` | Auditoria de dependencias (gate de CI) |
| `pnpm run demo:seed` | Datos sinteticos de demo (opt-in, ver `docs/demo.md`) |
| `pnpm --filter @workspace/api-server run db:generate` | Genera migraciones (revisar el SQL a mano) |

No hay linter configurado mas alla del typecheck de TypeScript.

## Seguridad

Resumen; el detalle verificable esta en
[`docs/security-overview.md`](docs/security-overview.md).

- **Aislamiento multi-tenant**: tres capas — scoping en repositorios, RLS en
  PostgreSQL (`lib/db/drizzle/0018_rls_tenant_policies.sql`) y resolucion de
  organizacion en la capa HTTP.
- **Separacion de roles en base de datos**: `app_role` es `NOBYPASSRLS`
  (sujeta a RLS); `bg_role` es `BYPASSRLS` y se usa solo para tareas internas.
- **Sesiones revocables**: cada JWT lleva un `jti` que debe existir en la tabla
  `sessions`; revocar la sesion invalida el token de inmediato.
- **Cifrado de credenciales de fuentes**: AES-256-GCM con clave derivada por
  SHA-256 de `SOURCE_ENCRYPTION_KEY`; fail-closed si falta en produccion.
- **CSRF** por token en cookie, **CORS** fail-closed (sin origen declarado =
  same-origin), **helmet** para headers.

## Demo

Ver [`docs/demo.md`](docs/demo.md) para el recorrido paso a paso y
`pnpm run demo:seed` para preparar datos sinteticos.

## Documentacion

| Documento | Contenido |
| --- | --- |
| [`DEPLOY.md`](DEPLOY.md) | Despliegue y configuracion |
| [`docs/operations-runbook.md`](docs/operations-runbook.md) | Runbook operativo (26 KB) |
| [`docs/security-overview.md`](docs/security-overview.md) | Postura de seguridad y limitaciones |
| [`docs/demo.md`](docs/demo.md) | Recorrido de demostracion |
| [`docs/ci.md`](docs/ci.md) | Workflow de CI |
| `docs/adr/` | Decisiones de arquitectura (ADR-001 a ADR-004) |

## Limitaciones conocidas

Documentadas explicitamente, sin adornos:

- **No hay MFA ni recuperacion de password.** El login es email + contrasena.
  Excluido de forma explicita en `ADR-003`.
- **El backup tiene disparador en codigo** (R9a): contrato `ops:backup-schedule` + unidades systemd, implementado y probado. No hay VPS ni entorno de produccion, asi que sigue siendo manual hasta que exista uno.
- **Hay mecanismo de alertas** (R9c), implementado y probado: el backup programado y el
  uploader emiten eventos de alerta mediante el seam generico `ALERT_CMD`; en el caso de
  fallo de subida, el uploader conserva el exit code `76`. No hay canal desplegado: sin
  configurar `ALERT_CMD` en un servidor, nadie recibe nada.
- **No hay B2, Object Lock, lifecycle ni PITR.** Bloqueados hasta que exista un
  VPS de produccion; la region de B2 es irreversible al crear la cuenta.
- **No hay TLS, reverse proxy ni dominio** en el repositorio.
- **La politica de `complianceScore` es ponderada por severidad** (`low`=1,
  `medium`=3, `high`=7, `critical`=15): `min(100, max(0, 100 - penalizacion))`,
  entero en `[0, 100]`. No es un porcentaje legal de cumplimiento ni una
  certificacion; la UI lo presenta como `score / 100`. Ver `docs/adr/ADR-004`.
- **El DR drill no cubre host-loss**: valida la preservacion de datos en local,
  no la recuperacion ante perdida de la maquina.