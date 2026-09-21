# M12 — Despliegue local con Docker Compose

Objetivo: levantar localmente PostgreSQL + API + frontend con un solo comando,
sin cambiar lógica de negocio. El scheduler corre dentro del proceso del API
exactamente como en desarrollo (`startScanScheduler()` en `src/index.ts`).

## Arranque

```bash
cp .env.example .env        # completar JWT_SECRET y SOURCE_ENCRYPTION_KEY
openssl rand -base64 48     # generar JWT_SECRET (una línea)
docker compose up --build -d
docker compose logs -f api web
```

## Flujo de arranque

1. `db` (postgres:16-alpine, volumen `pgdata`, healthcheck `pg_isready`).
2. `migrate` (job one-shot con la imagen del API): `pnpm --filter @workspace/db
   run db:migrate`. **Las migraciones NO corren dentro de las réplicas del API**
   para evitar carreras; el API solo arranca cuando el job termina
   (`service_completed_successfully`).
3. `api` (Node 22, usuario no-root, healthcheck `/api/livez`).
4. `web` (nginx:alpine con `dist/public`, SPA fallback a `index.html`,
   proxy `/api/` → `api:5000`).

## Probes

- Liveness: `GET /api/livez` — nunca toca la BD (ver `routes/health.ts`).
- Readiness: `GET /api/readyz` — `SELECT 1` (fail-closed, 503 si la BD cae).

## Comandos útiles

```bash
docker compose build            # construir imágenes (sin arrancar)
docker compose config          # validar compose (no requiere daemon en todos los casos)
docker compose up -d           # arrancar (ver nota Docker abajo)
docker compose ps              # estado
docker compose logs api        # logs del API
curl http://localhost:5000/api/livez    # liveness
curl http://localhost:5000/api/readyz   # readiness
curl http://localhost:8080/             # frontend
docker compose down            # detener
docker compose down -v         # detener + borrar datos (¡destructivo!)
```

> Nota: en el entorno de desarrollo actual `docker` no está instalado, por lo
> que `build`/`up`/`config` están **pendientes de validación real** (ver
> "Riesgos conocidos").

## Variables (ver `.env.example`)

Obligatorias en producción: `JWT_SECRET` (>= 32 chars, fail-fast en startup),
`SOURCE_ENCRYPTION_KEY` (>= 32 chars, fail-fast), `DATABASE_URL` (la compone
el compose desde `POSTGRES_*`, salvo override).

## Notas de seguridad

- JWT/DB/claves **nunca** entran en la imagen: solo via `environment` en
  runtime. `.env` está ignorado por git y docker.
- `TRUST_PROXY=true` en compose (nginx delante) para `req.ip`/rate-limit.
- En producción tras TLS, la cookie es `Secure` automática (`NODE_ENV`).

## Riesgos conocidos

- Primera build pesada (pnpm instala todo el monorepo en la etapa `deps`);
  las siguientes usan layer caching de `package.json`+lockfile.
- `pnpm audit` no es ejecutable en todos los entornos (requiere red al índice
  de advisories); no bloquea el despliegue.
