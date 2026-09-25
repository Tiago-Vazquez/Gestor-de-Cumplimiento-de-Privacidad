# M12 — Despliegue local con Docker Compose

## M24 — Backups y Disaster Recovery

El despliegue Compose actual usa PostgreSQL 16 Alpine y un volumen Docker nombrado
`pgdata` (`/var/lib/postgresql/data`). El backup operativo de M24 es **lógico**:
`pg_dump` en formato custom, acompañado de un export de roles sin contraseñas y
un manifiesto con SHA-256, versión de PostgreSQL, número de migraciones y conteos
de tablas esenciales. No se respaldan los secretos de `.env`, las claves de cifrado
ni los volúmenes de fuentes externas.

### Política inicial

- **Frecuencia:** una ejecución diaria como mínimo; puede incrementarse según el
  SLA del cliente.
- **Retención:** 14 días por defecto (`BACKUP_RETENTION_DAYS=14`). La retención
  se aplica solo a los tres artefactos `m24-postgres-*` del directorio elegido.
- **Ubicación:** un volumen/almacenamiento externo al repositorio y al host Docker.
  El script rechaza directorios dentro del repo, salvo que se use
  `ALLOW_LOCAL_BACKUP=1` únicamente para un drill.
- **Protección:** permisos `600`, cifrado del almacenamiento subyacente y control
  de acceso al secreto/almacenamiento. El dump contiene datos de negocio cifrados
  en la capa de fuentes, por lo que debe tratarse como información sensible.
- **Verificación:** el script ejecuta `pg_restore --list` y genera checksums; el
  restore vuelve a verificar ambos checksums antes de tocar una base destino.

Estos valores son **objetivos iniciales**, no garantías de SLA:

- **RPO objetivo:** 24 horas para la última ejecución lógica completa.
- **RTO objetivo:** 4 horas para detectar, preparar un destino limpio, restaurar,
  ejecutar migraciones y validar API/datos.

Compose no configura PITR, WAL archiving ni réplicas. Por tanto, M24 no promete
recuperación a un punto en el tiempo ni protege contra pérdida del host/disco.
Una evolución comercial posterior debe añadir backups off-host/PITR y una prueba de
restore automatizada en CI.

### Crear y verificar un backup

```bash
# BACKUP_DIR debe estar fuera del repositorio.
BACKUP_DIR=/secure/backups/privacy/postgres \\
BACKUP_RETENTION_DAYS=14 \\
  pnpm run ops:backup
```

Salida típica:

```text
backup=/secure/backups/privacy/postgres/m24-postgres-<timestamp>-<sufijo>.dump
roles=...roles.sql
manifest=...manifest
```

#### Concurrencia, unicidad y códigos de salida (M25.2)

El script está preparado para ejecución desatendida. No implementa todavía ningún
disparador (ni cron ni scheduled actions): eso es M25.3.

**Lock.** Se usa un **lock-dir**, no `flock(1)`, porque `flock` no existe en las
shells mínimas contra las que se desarrolla este repositorio y porque un lock-dir
funciona igual en el contenedor de backup y en el host. El lock es
`$BACKUP_DIR/.m24-backup.lock` (configurable con `BACKUP_LOCK_DIR`).

- Se toma **antes de cualquier trabajo** y se libera con el trap `EXIT` tanto en
  éxito como en error, y también con `SIGINT`/`SIGTERM`.
- Un proceso terminado con `SIGKILL` no puede ejecutar ningún trap, así que el
  lock se recupera comprobando la liveness del PID: si el PID ya no existe, el
  lock se considera obsoleto y se reclama. Si el fichero `pid` no es legible, solo
  se reclama cuando el lock es más antiguo que `BACKUP_LOCK_GRACE_SECONDS`
  (120 s por defecto), para no robarle el lock a una ejecución que aún no lo
  escribió.
- Si el lock está tomado, el script **no hace nada** y lo dice explícitamente.

**Códigos de salida**

| Código | Significado |
| --- | --- |
| `0` | Backup completo y verificado |
| `1` | Error (dump vacío, base inaccesible, `BACKUP_DIR` inválido…) |
| `75` | `EX_TEMPFAIL`: hay otro backup en ejecución, no se inicia nada |

`75` es el valor que un planificador debe tratar como "reintentar más tarde", no
como fallo definitivo.

**Unicidad de artefactos.** El nombre base es
`m24-postgres-<timestamp-UTC>-<sufijo>`, donde el sufijo son los 6 caracteres
aleatorios que `mktemp` ya usaba para el directorio temporal. `mktemp` garantiza
que ese nombre no está en uso, de modo que **dos ejecuciones dentro del mismo
segundo no pueden colisionar**, incluso si se repiten de inmediato. El lock
serializa ejecuciones concurrentes; el sufijo cubre la colisión restante entre
ejecuciones consecutivas en el mismo segundo.

**Limpieza.** El lock nunca debe quedar en el directorio tras una ejecución
correcta. Si aparece y no hay ningún backup corriendo, se puede borrar a mano y
reintentar; el script también lo reclamo solo por las reglas de obsolescencia
descritas arriba.

El export `.roles.sql` es inventario de cluster y **no se ejecuta durante el
restore** (contiene el rol administrativo original). El restore crea los roles
runtime mediante `scripts/ops/restore-roles.sql` y provisiona sus contraseñas con
`db:provision-roles`. Si el proyecto destino ya existe, el script se niega a
continuar; `RESTORE_REPLACE=1` requiere una decisión explícita de corte.

### Restore reproducible

El destino debe ser un proyecto Compose nuevo. No se debe apuntar el comando al
proyecto/volumen de producción ni usar `RESTORE_REPLACE=1` sin una decisión
explícita de corte:

```bash
export RESTORE_CONFIRM=RESTORE
export RESTORE_PROJECT_NAME=privacy-restore-$(date +%Y%m%d%H%M%S)
export RESTORE_POSTGRES_PASSWORD='...'
export RESTORE_APP_ROLE_PASSWORD='...'
export RESTORE_BG_ROLE_PASSWORD='...'
export RESTORE_JWT_SECRET='...al menos 32 caracteres...'
export RESTORE_SOURCE_ENCRYPTION_KEY='...al menos 32 caracteres...'

pnpm run ops:restore -- \\
  --backup /secure/backups/privacy/postgres/m24-postgres-<timestamp>.dump \\
  --roles /secure/backups/privacy/postgres/m24-postgres-<timestamp>.roles.sql \\
  --manifest /secure/backups/privacy/postgres/m24-postgres-<timestamp>.manifest
```

El script:

1. valida checksums y la lista TOC del archivo;
2. arranca un PostgreSQL 16 aislado;
3. espera una conexión real a la base destino;
4. crea roles runtime con privilegios mínimos;
5. ejecuta `pg_restore --exit-on-error --single-transaction`;
6. ejecuta las migraciones y provisioning de roles;
7. arranca la API y comprueba `/api/livez` y `/api/readyz`;
8. compara conteos y verifica `RLS` y `FORCE RLS` activos en **las 7 tablas**
   protegidas por la migración `0018` (`sources`, `findings`, `reports`,
   `activity`, `scans`, `scan_schedules`, `masking_jobs`), y falla si alguna no
   está en `public`, no existe, o perdió cualquiera de los dos atributos;
9. verifica los atributos de los roles runtime: `app_role` con `NOBYPASSRLS` y
   `bg_role` con `BYPASSRLS`;
10. elimina red/volumen/contenedores al salir, salvo `RESTORE_KEEP=1`.

Para un drill local en un host donde BuildKit no puede terminar `chown` sobre
`node_modules`, se pueden suministrar imágenes ya construidas:

```bash
export RESTORE_API_IMAGE=gestor-de-cumplimiento-de-privacidad-api:latest
export RESTORE_MIGRATE_IMAGE=gestor-de-cumplimiento-de-privacidad-migrate:latest
```

Los overrides son opcionales; el flujo normal y CI no los usan.

### Criterio de restore válido

Un restore solo se considera válido cuando termina con `restore=ok`, ambos probes
devuelven JSON healthy, los conteos del manifiesto coinciden, la comprobación RLS no
falla y los atributos de los roles son los esperados. El dump por sí solo no es
evidencia de recuperación.

Dos condiciones de seguridad son parte de ese criterio y no son negociables:

- **RLS completo:** las 7 tablas de la migración `0018` conservan `ENABLE` y
  `FORCE ROW LEVEL SECURITY`. Verificar una sola tabla dejaría pasar un restore con
  el resto del aislamiento multi-tenant anulado.
- **Roles correctos:** `app_role` existe con `NOBYPASSRLS` y `bg_role` con
  `BYPASSRLS`. Si el dump resucitara `app_role` como un rol con `BYPASSRLS`, el
  aislamiento por tenant se anularía en silencio y ningún test de conteos lo
  detectaría.
- **Clave de cifrado usable (M25.3):** el restore **descifra de verdad** una
  `sources.connection_config` contra la base restaurada. Hasta M25.3 esto no se
  comprobaba, por lo que un restore hecho con la clave equivocada pasaba todos los
  demás criterios y aun así dejaba todas las fuentes sin conectar.

#### Verificación de `SOURCE_ENCRYPTION_KEY` (M25.3)

El manifest incluye `source_key_fingerprint`, que es `sha256(sha256(clave))`: una
huella de la clave **derivada**, que permite comparar sin exponer el secreto. Se
calcula **dentro del contenedor `api`**, que es el único que tiene la clave en su
entorno, de modo que la clave cruda nunca llega al host ni al manifest.

| Estado | Comportamiento del restore |
| --- | --- |
| Fingerprint presente y coincide | Continúa al descifrado |
| Fingerprint presente y **difiere** | **Falla de inmediato**, sin intentar descifrar |
| Fingerprint **ausente** (backup anterior a M25.3) | **Aviso** y continúa; el descifrado sigue verificando la clave |

El descifrado se ejecuta en el contenedor `migrate` —el único del stack con Node y
`pg` resoluble— usando la conexión administrativa. **Nunca** con `app_role`: con
RLS y sin `app.tenant_id` devolvería cero filas y produciría un falso verde.

La salida del check es explícita sobre el estado real:

```text
key_check_total_sources=3
key_check_encrypted_sources=1
key_check_null_sources=2
key_check_fingerprint=match
key_check_verified=true
```

- `key_check_null_sources` cuenta las fuentes legacy sin configuración de conexión.
  **No se contabilizan como verificadas.**
- Si no hay ninguna fuente cifrada, el check **no** afirma verificación: informa
  `key_check_verified=false` y `key_check_reason=no_encrypted_sources`, y el
  restore continúa con un aviso. Es un estado honesto, no un verde.
- `key_check_verified=true` solo aparece tras descifrar un valor de verdad. Como
  AES-256-GCM es autenticado, descifrar correctamente **es** la prueba de que la
  clave es la correcta.

El algoritmo está replicado en `scripts/ops/verify-source-key.cjs` porque ninguna
imagen incluye `artifacts/api-server/src/lib/secret-manager.ts`. Esa duplicación
está anclada por
`artifacts/api-server/src/__tests__/restore-key-check-anchor.test.ts`, que falla si
deja de coincidir con `decrypt()` real. El **formato del ciphertext no se modifica**
en ningún momento.

### Runbook

La respuesta a incidentes y los pasos de operación están en
[`docs/operations-runbook.md`](docs/operations-runbook.md).

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
2. `migrate` (job one-shot con la imagen del API): `db:migrate && db:provision-roles`
   (migra `0000..0019` y provisiona las contraseñas de `app_role`/`bg_role` desde
   `APP_ROLE_PASSWORD`/`BG_ROLE_PASSWORD`; la migración `0019` las deja en NULL).
   **Las migraciones NO corren dentro de las réplicas del API** para evitar
   carreras; el API solo arranca cuando el job termina
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

> M24 validó localmente `docker compose config`, la suite real de conectores
> (19/19), un backup real y un restore end-to-end en un proyecto PostgreSQL 16
> aislado. En otro host, ejecuta los mismos comandos antes de declarar disponible
> el servicio.

## Variables (ver `.env.example`)

Obligatorias en producción: `JWT_SECRET` (>= 32 chars, fail-fast en startup),
`SOURCE_ENCRYPTION_KEY` (>= 32 chars, fail-fast), `POSTGRES_PASSWORD`
(superusuario `privacy`), `APP_ROLE_PASSWORD` y `BG_ROLE_PASSWORD` (roles de
aplicación; provisionadas por `db:provision-roles`). `DATABASE_URL`/`BG_DATABASE_URL`
las compone el compose a partir de esos secretos; `ADMIN_DATABASE_URL` es la
conexión de superusuario usada por migraciones/provisioning.

## Primer administrador (instalación nueva)

El bootstrap legacy fue eliminado. Provisionar el primer admin una sola vez:

```bash
ADMIN_DATABASE_URL='postgresql://privacy:...@db:5432/privacy' \
PROVISION_ADMIN_EMAIL='admin@example.com' \
PROVISION_ADMIN_PASSWORD='...' \
pnpm --filter @workspace/db run db:provision-admin
```

Luego el admin inicia sesión con email + password. Idempotente.

## Notas de seguridad

- JWT/DB/claves **nunca** entran en la imagen: solo via `environment` en
  runtime. `.env` está ignorado por git y docker.
- `TRUST_PROXY=true` en compose (nginx delante) para `req.ip`/rate-limit.
- En producción tras TLS, la cookie es `Secure` automática (`NODE_ENV`).

## Riesgos conocidos

- Primera build pesada (pnpm instala todo el monorepo en la etapa `deps`);
  las siguientes usan layer caching de `package.json`+lockfile.
- `pnpm audit --audit-level high` es ahora un gate obligatorio de CI; la
  ejecución local validada dejó 1 advisory low y 4 moderate, todos en tooling
  de desarrollo/test. El gate high/critical está en verde y los advisories
  residuales están documentados en `docs/ci.md`.
