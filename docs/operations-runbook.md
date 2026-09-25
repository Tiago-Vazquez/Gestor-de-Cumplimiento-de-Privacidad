# M24 — Runbook operacional

Este runbook aplica al despliegue Docker Compose del repositorio. Ejecuta los
comandos desde la raíz del repositorio y usa un ticket/incidente con hora UTC,
operador y request ID cuando corresponda.

## Reglas de seguridad

- No uses `docker compose down -v` sobre producción: elimina el volumen `pgdata`.
- No imprimas `.env`, URLs con contraseñas, JWT, cookies, CSRF ni
  `connectionConfig` en logs, tickets o capturas.
- No ejecutes `db:push`, `push-force` ni edites una migración ya aplicada.
- Antes de una intervención destructiva, conserva logs, audit events y un backup
  verificado.
- Un dump no es evidencia de recuperación hasta que restore → migraciones → API
  → health checks → conteos/RLS termina correctamente.

## 1. API caída o no saludable

### Síntomas

- `docker compose ps` muestra `api` como `unhealthy`, `restarting` o exited.
- `GET http://localhost:${API_PORT:-5000}/api/livez` no responde.
- `GET .../api/readyz` devuelve 503 aunque el proceso responda.

### Diagnóstico

```bash
docker compose ps
docker compose logs --tail=200 api
curl -i http://localhost:${API_PORT:-5000}/api/livez
curl -i http://localhost:${API_PORT:-5000}/api/readyz
```

Interpretación:

- `livez` falla: proceso, red, imagen o container runtime.
- `livez` 200 y `readyz` 503: proceso vivo; revisar PostgreSQL/migraciones/RLS.
- `api` reinicia: revisar variables fail-fast, memoria, crash logs y `migrate`.

### Recuperación conservadora

```bash
docker compose restart api
docker compose ps api
curl -i http://localhost:${API_PORT:-5000}/api/livez
curl -i http://localhost:${API_PORT:-5000}/api/readyz
```

Si el problema sigue, no borres el volumen. Revisa `docker compose logs --tail=300
migrate db` y continúa con la sección de migración o PostgreSQL. Si se requiere
reconstruir la imagen, usa `docker compose build api && docker compose up -d api`
y conserva el volumen.

## 2. PostgreSQL caído

### Síntomas

- `db` no está healthy o exited.
- `readyz` devuelve 503; `livez` puede seguir en 200.
- `migrate` puede quedar exited con error.

### Diagnóstico

```bash
docker compose ps db
docker compose logs --tail=200 db
docker compose exec -T db sh -c 'pg_isready -U "$POSTGRES_USER" -d "$POSTGRES_DB"'
docker volume ls | grep pgdata
```

Revisa espacio del host, salud del contenedor, límites de recursos y mensajes de
PostgreSQL. No borres `pgdata` para “resolver” una caída.

### Recuperación

```bash
docker compose restart db
docker compose exec -T db sh -c 'pg_isready -U "$POSTGRES_USER" -d "$POSTGRES_DB"'
docker compose ps db api
curl -i http://localhost:${API_PORT:-5000}/api/readyz
```

Si el volumen está corrupto o no arranca, detén la API, documenta la evidencia y
usa [`DEPLOY.md`](DEPLOY.md#m24--backups-y-disaster-recovery) para restaurar en
un proyecto/volumen nuevo. El cambio de tráfico debe ser una decisión operador.

## 3. Migración fallida

### Identificar

```bash
docker compose ps -a migrate
docker compose logs --tail=300 migrate
docker compose logs --tail=100 db
```

No reintentes automáticamente ni edites el SQL versionado. Identifica el
`0019`/última entrada de `drizzle.__drizzle_migrations` y correlaciona con el
código desplegado.

### Recuperar

1. Conserva logs y crea/valida un backup si el estado no es inequívoco.
2. Corrige la causa en una nueva migración revisada o restaura un dump conocido.
3. Ejecuta el job one-shot de migración:

```bash
docker compose run --rm migrate
```

4. Comprueba el estado del job y los probes:

```bash
docker compose ps -a migrate api
curl -i http://localhost:${API_PORT:-5000}/api/livez
curl -i http://localhost:${API_PORT:-5000}/api/readyz
```

La API solo debe recibir tráfico después de `service_completed_successfully` del
job `migrate`. Un `readyz` 503 no se debe “resolver” desactivando autenticación o
RLS.

## 4. Scan atascado

### Identificar

Los endpoints requieren autenticación; usa la UI o un cliente con sesión y CSRF,
sin pegar tokens en tickets:

```bash
curl -i 'http://localhost:${API_PORT:-5000}/api/scans?status=running'
curl -i 'http://localhost:${API_PORT:-5000}/api/metrics'
docker compose logs --since=30m api | grep -Ei 'scan|scheduler|reaper|connector'
```

En base de datos, como diagnóstico de solo lectura, usa una conexión
administrativa o fija explícitamente `app.tenant_id` para el tenant:

```sql
SELECT id, source_id, status, started_at, heartbeat_at, cancel_requested
FROM scans
WHERE status = 'running'
ORDER BY started_at;
```

### Actuar

- Un scan `running` con `cancel_requested=true` se cancelará en el siguiente
  punto cooperativo del scanner.
- Como admin, solicita cancelación por el endpoint documentado:
  `POST /api/scans/{id}/cancel`; no hagas `UPDATE` manual sobre `scans`.
- El reaper recupera scans huérfanos/stale y los termina como `failed(timeout)`.
- No mates el contenedor repetidamente para “resolver” un scan: puede dejar el
  proceso en estado inconsistente y no es una estrategia de recuperación.
- Revisa la fuente externa, timeout/conexión y logs; reinicia solo el proceso si
  el scan quedó huérfano y el reaper no lo ha terminado.

## 5. Incidente de seguridad

### Primeros pasos

1. Declara el incidente y conserva hora UTC, request IDs, actor, acción y recursos.
2. No borres logs, `audit_events`, sesiones o fuentes como primer paso.
3. Si hay exposición activa, limita el tráfico en el proxy/entrada y decide si la API
   debe detenerse sin apagar la base para preservar evidencia.
4. Consulta la evidencia con los endpoints existentes:
   `GET /api/audit-events/platform` (admin de plataforma),
   `GET /api/audit-events` (tenant activo) y `GET /api/metrics`.

### Revocación y rotación

- Para la cuenta afectada usa la gestión existente de sesiones:
  `GET /api/auth/sessions`, `DELETE /api/auth/sessions/:jti` o
  `POST /api/auth/logout-all`, con sesión autorizada y CSRF válido.
- Para una respuesta global, coordina la revocación de sesiones y la rotación de
  `JWT_SECRET` mediante el gestor de secretos; reinicia la API para invalidar
  tokens emitidos con la clave anterior.
- Si se comprometieron credenciales de una fuente, rota la credencial en la fuente
  y actualiza el secreto cifrado mediante el flujo normal. No rotes
  `SOURCE_ENCRYPTION_KEY` a ciegas: las conexiones existentes quedarían ilegibles.
- No imprimas valores nuevos o antiguos de secretos ni los incluyas en el ticket.

Revisa `security_violation`, `login_failure`, `session_expired`,
`inactivity_timeout`, cambios de roles y accesos de plataforma. Si el acceso pudo
alterar datos, restaura según DR y valida conteos/RLS antes del cierre.

## 6. Restauración desde backup

1. Identifica dump, roles inventory y manifest fuera del repositorio.
2. Verifica ambos SHA-256 y el entorno de destino.
3. Ejecuta `pnpm run ops:restore -- ...` siguiendo [`DEPLOY.md`](DEPLOY.md#restore-reproducible).
4. Exige `restore=ok`, ambos probes 200, conteos coincidentes y RLS/FORCE RLS.
5. Usa `RESTORE_KEEP=1` solo para inspección/cutover; después limpia el proyecto
   con `docker compose -p <project> -f scripts/ops/docker-compose.restore.yml down --volumes --remove-orphans`.

## 7. Observabilidad mínima actual

```bash
docker compose ps
docker compose logs --since=30m api migrate db
curl -s http://localhost:${API_PORT:-5000}/api/metrics
```

El repositorio expone logs estructurados, `X-Request-Id`, métricas Prometheus y
probes, pero aún no incluye alerting, PITR, réplicas ni retención centralizada.
Eso queda explícitamente fuera de M24 y debe cerrarse antes de un SLA comercial
fuerte.

