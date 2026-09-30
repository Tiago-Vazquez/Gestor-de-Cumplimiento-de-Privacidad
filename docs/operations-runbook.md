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
4. Exige `restore=ok`, ambos probes 200, conteos coincidentes, RLS/FORCE RLS y
   `key_check_verified=true` (M25.3).
5. Usa `RESTORE_KEEP=1` solo para inspección/cutover; después limpia el proyecto
   con `docker compose -p <project> -f scripts/ops/docker-compose.restore.yml down --volumes --remove-orphans`.

## 7. El restore falla por clave de cifrado

### Identificar

Desde M25.3 el restore **descifra de verdad** una credencial de fuente. Dos fallos
son posibles y significan cosas distintas:

```text
restore: SOURCE_ENCRYPTION_KEY does not match this backup (fingerprint mismatch); refusing to declare the restore usable
```

El manifest lleva `source_key_fingerprint` y la clave que usaste no corresponde a
ese backup. **Falla antes de descifrar.**

```text
key-check: decryption failed: Unsupported state or unable to authenticate data
```

El manifest no traía fingerprint (backup anterior a M25.3) y la clave resulta ser
incorrecta: AES-256-GCM rechazó el tag de autenticación.

### Resolver

1. **No es un fallo de la base restaurada.** Los conteos, RLS y roles ya pasaron:
   el problema es exclusivamente la clave.
2. Recupera la clave correcta según el procedimiento de custodia de
   `DEPLOY.md`. No pruebes claves a fuerza bruta: el fingerprint del manifest ya
   te dice si la que tienes es la correcta.
3. Un `key_check_verified=false` con `key_check_reason=no_encrypted_sources` **no es
   un fallo**: el backup no contenía ninguna fuente con configuración cifrada, así
   que no había nada que verificar. Es un estado honesto, no un verde.

## 8. El backup no arranca porque hay otro en ejecución

### Identificar

Un backup que termina con código **75** no está fallando: significa que otro
proceso ya tiene el lock. El mensaje incluye el PID:

```text
backup: another backup already holds /secure/backups/privacy/postgres/.m24-backup.lock (pid 1026); not starting
```

### Resolver

1. Comprueba si realmente hay un backup en curso antes de tocar nada:

   ```bash
   cat /secure/backups/privacy/postgres/.m24-backup.lock/pid
   ps -p "$(cat /secure/backups/privacy/postgres/.m24-backup.lock/pid)"
   ```

2. Si el proceso existe, **espera**: el lock se libera solo al terminar. No lo
   borres a la fuerza, porque Could dos backups correr a la vez.

3. Si el proceso **no** existe, el lock es residual. Puedes esperar a que el
   script lo reclame solo (comprueba la liveness del PID), o borrarlo y reintentar:

   ```bash
   rm -rf /secure/backups/privacy/postgres/.m24-backup.lock
   ```

   El código 75 debe tratarse como "reintentar más tarde" en cualquier
   planificador, nunca como fallo definitivo.

## 9. El restore falla por checksum

### Identificar

Desde M25.5 el mensaje distingue **hash mal formado** de **contenido distinto**:

```text
restore: manifest dump_sha256 is not a valid 64-character SHA-256
```

Un valor de 64 caracteres que no sea hex minúsculo, o de longitud distinta, se
rechaza aquí. Antes se comparaba directamente y el resultado era un
`checksum mismatch` que inducía a pensar en corrupción.

```text
restore: checksum mismatch for /secure/.../m24-postgres-....dump
```

Aquí el formato es correcto pero el contenido no coincide: corrupción real o
artefacto sustituido.

### Causa histórica importante

Los backups creados desde **Git Bash/MSYS en Windows** pueden tener en su manifest
un hash con un **backslash inicial** (`\d51a38b7…`, 65 caracteres). Eso no es
corrupción: `sha256sum` escapaba la barra invertida de la ruta y el valor quedó
grabado así. Desde M25.5:

- El backup **nunca más** genera ese prefijo: el hash se calcula leyendo el
  fichero por stdin, así que la ruta nunca llega a la herramienta.
- El restore **normaliza** un único `\` inicial al leer el manifest, de modo que
  **los backups históricos afectados siguen restaurables** sin reescribirlos.

Si ves un `checksum mismatch` en un backup antiguo creado en Windows, comprueba
antes que el dump no haya sido modificado: el prefijo ya no debe impedir el
restore.

## 10. El restore avisa de divergencia de migraciones

### Identificar

```text
restore: WARNING the restored migration journal does not match the current .sql files.
```

**No es un fallo y el restore continúa.** Significa que alguna migración ya
aplicada fue editada después. Drizzle decide "ya aplicada" por `created_at` y nunca
compara el hash, así que la omite en silencio y el esquema restaurado queda
divergente respecto al código actual.

### Resolver

1. Confirma que el aviso es real: el mensaje lista los hashes afectados.
2. Si el backup es reciente, restaura de nuevo tras corregir la migración.
3. Si el backup es antiguo, el aviso es **esperable**: restaurar un backup previo
   es justamente el propósito del DR. Investiga solo si la API falla en runtime.

La verificación dura (`migration journal mismatch`, sin WARNING) significa otra
cosa: el dump **no** corresponde a ese manifest y el restore se detiene.

## 11. Restaurar sin acceso al repositorio (bundle de M26.0)

### Qué cambió en M26.0

Antes de M26.0 este procedimiento era incompleto: `postgres-restore.sh` resuelve
sus helpers del checkout, así que sin repositorio el restore no se ejecutaba.
M26.0 entregó `build-restore-bundle.sh`, que empaqueta esas dependencias para
poder restaurar en un host limpio.

### Qué es el bundle

```bash
pnpm run ops:build-bundle -- --commit <sha>
```

El tarball contiene **todo lo que `postgres-restore.sh` resuelve del
repositorio**:

| Contenido | Para qué sirve |
| --- | --- |
| `scripts/ops/postgres-restore.sh` | El ejecutable del restore |
| `scripts/ops/common.sh` | Helpers de hash y normalización |
| `scripts/ops/verify-source-key.cjs` | Verificación criptográfica de la clave |
| `scripts/ops/restore-roles.sql` | Bootstrap de roles de mínimo privilegio |
| `scripts/ops/docker-compose.restore.yml` | Stack PostgreSQL aislado |
| `lib/db/drizzle/**` | Migraciones, incluidas en el journal |
| `MANIFEST.bundle` | Commit, imágenes y declaraciones de exclusión |
| `MANIFEST.bundle.sha256` | Checksums de cada fichero empaquetado |
| `INSTRUCCIONES.md` | Orden de restauración |

### Lo que el bundle NO contiene

Garantizado por el constructor, que aborta si lo encuentra:

- **Backups.** Los tres artefactos viven en el almacenamiento off-host.
- **`SOURCE_ENCRYPTION_KEY`.** Va por un canal de custodia separado.
- **Credenciales de almacenamiento** (`B2_*`). La de lectura se entrega fuera
  de banda durante el incidente.
- **Código de la aplicación.** Solo viaja el tooling de restore.

`MANIFEST.bundle` lo declara con `contains_source_encryption_key=no` y
`contains_storage_credentials=no`.

### Imágenes por digest

El constructor **rechaza** una imagen por tag y solo acepta `nombre@sha256:...`:

```bash
RESTORE_API_IMAGE=privaris-api@sha256:<64-hex> \
RESTORE_MIGRATE_IMAGE=privaris-migrate@sha256:<64-hex> \
  bash scripts/ops/build-restore-bundle.sh --commit <sha>
```

Un tag puede moverse después de construir el bundle, y entonces el host de DR
ejecutaría código nunca verificado contra él. Sin digest, el constructor emite un
`WARNING`: el bundle es completo pero **no es reproducible**.

### Autoverificación

El constructor no se declara correcto por haber escrito un fichero: extrae lo que
acaba de generar, verifica sus checksums, confirma los cinco ficheros
obligatorios y la presencia de migraciones, y **falla** si algo no cuadra. En el
host de DR se repite antes de restaurar:

```bash
sha256sum -c MANIFEST.bundle.sha256
```

### Relación entre el bundle y el almacenamiento off-host

Son piezas complementarias: el **bundle** lleva las *herramientas* para restaurar,
el **bucket** lleva los *datos* (`<base>.dump`, `.roles.sql`, `.manifest`).
Ninguno sirve sin el otro: un bundle sin dump no restaura nada, y un dump sin
bundle obliga a reconstruir el tooling en el peor momento.

### Límites actuales — leer antes de un DR real

1. **No hay verificación contra Backblaze B2 real.** `offhost-upload.sh` está
   probado **en contrato** contra un doble local (`OFFHOST_S3_CMD`), sin red ni
   credenciales. Object Lock, lifecycle y la firma SigV4 **nunca se ejecutaron**
   contra el proveedor. La cuenta no existe: la región se elige al crearla y no
   puede cambiarse.
2. **No hay ensayo de DR sobre un host limpio.** El bundle se ha construido,
   extraído y validado, y `postgres-restore.sh` arranca desde el directorio
   extraído. **No** se ha probado el ciclo backup → off-host → restore completo.
3. **Sin scheduler ni alertas** (ver la sección 12).

## 12. Observabilidad: qué existe y qué no

```bash
docker compose ps
docker compose logs --since=30m api migrate db
curl -s http://localhost:${API_PORT:-5000}/api/metrics
```

El repositorio expone logs estructurados, `X-Request-Id`, métricas Prometheus y
probes. **Lo siguiente sigue abierto:**

| Ítem | Estado | Por qué |
| --- | --- | --- |
| **R9a — scheduler de backup** | **Implementado en código, pendiente de desplegar** | El contrato es `scripts/ops/backup-schedule.sh` + unidades systemd; falta instalarlo y probarlo en el VPS |
| **R9c — alertas** | **Abierto** | Nada notifica un backup fallido (M29.2 A2) |
| **R9d — retención remota** | **Diseñado, no aplicado** | Las reglas lifecycle están decididas (90 d) pero exigen bucket |
| **Salida `76` del uploader** | **Implementada** | Distingue subida fallida de fallo local |
| **PITR / WAL** | **Abierto** | ADR-002 D5 lo aísla; sin destino off-host no puede ejecutarse |
| **Réplicas / HA** | **Fuera de alcance** | ADR-002 D0 asume un único VPS |

### El código 76 y por qué importa

| Código | Significado |
| --- | --- |
| `0` | Los tres objetos publicados |
| `1` | Configuración inválida; nada se publica |
| `76` | Backup local correcto, **subida remota fallida** |

Sin esa distinción, un `1` (disco lleno) y un `76` (host sano sin copia externa)
serían el mismo aviso. **Hoy nadie consume esa señal**: es lo que un monitor
necesitaría, y el monitor no existe.

El backup local **nunca** se borra ante un `76`, y el uploader **no** intenta un
### Qué dispara el backup

`scripts/ops/backup-schedule.sh` es el contrato; el calendario vive fuera del
repositorio:

```bash
# VPS: instalar el calendario
sudo cp scripts/ops/backup-schedule.service scripts/ops/backup-schedule.timer /etc/systemd/system/
sudo systemctl daemon-reload && sudo systemctl enable --now backup-schedule.timer
systemctl list-timers backup-schedule.timer     # próxima ejecución

# ejecutar a mano, fuera de horario
sudo systemctl start backup-schedule.service
journalctl -u backup-schedule.service -n 50
```

Sin unidades systemd, el equivalente es una entrada de cron (ver `DEPLOY.md`).

**Por qué no GitHub Actions:** la base de producción es privada y el disco de un
runner de GitHub es efímero, así que un `schedule` allí no ejecutaría el backup
real. El script del repositorio es el mismo en ambos casos.

**Interpretar el resultado.** Cada ejecución deja una línea
`backup-schedule: result=<ok|skipped_locked|partial_upload_failed|failed> exit_code=<n>`
con el **mismo** código que devolvió `postgres-backup.sh` (`0`, `75`, `76` u otro):

- `skipped_locked` (75) **no es un fallo**: ya había un backup en curso.
- `partial_upload_failed` (76) **sí requiere atención**: el backup local está bien
  pero no llegó a off-host. Es la señal que R9c deberá notificar.
borrado compensatorio de lo ya publicado: un set sin `.manifest` es inutilizable
por diseño, y los huérfanos los reclama el lifecycle.

## 13. Pérdida de `SOURCE_ENCRYPTION_KEY`

### Qué clave es

Es el secreto de la aplicación, distinto de las contraseñas de PostgreSQL y de
`JWT_SECRET`. Cifra con **AES-256-GCM** la configuración de conexión completa de
cada fuente (`sources.connection_config`, serializada como `JSON`). La clave
efectiva es `sha256(secreto)`, sin KDF con sal ni coste.

### Qué queda afectado si se pierde

**Solo las credenciales de las fuentes de datos.** El resto sigue funcionando:

| Afectado | No afectado |
| --- | --- |
| `sources.connection_config` ilegible | Usuarios, organizaciones, membresías |
| Los escaneos no conectan con las fuentes | Hallazgos ya escaneados y persistidos |
| Cada fuente muestra error de credenciales | Sesiones, invitaciones, auditoría |
| | `JWT_SECRET` (independiente) |
| | `POSTGRES_PASSWORD` y roles de runtime |
| | Esquema y migraciones |

**El backup no está cifrado con esta clave.** Es el cifrado de la *aplicación*;
el dump viaja con el cifrado en reposo del proveedor. Perder la clave **no**
impide restaurar la base: impide que las fuentes conecten.

### Por qué no se puede rotar

ADR-002 D3 lo declara: **no hay versionado de clave**. `decrypt` no puede
distinguir "cifrado con la clave anterior" de "cifrado corrupto". Rotar sin migrar
deja **ilegibles todas las configuraciones ya almacenadas**. Es un secreto de por
vida del despliegue.

### Material que debe existir fuera del host

ADR-002 D2 establece custodia **operativa**: **dos copias offline en ubicaciones
separadas**. Nunca en el repositorio ni en el bundle, ni en el bucket, ni junto a
las credenciales `B2_*`.

Una copia fuera del host **no** es copia en el bucket: comprometer el bucket
comprometería la clave.

### Verificar que una clave recuperada es la correcta

Cada backup M25.3+ lleva `source_key_fingerprint` en su manifest:
`sha256(sha256(clave))`. Se calcula **dentro del contenedor `api`**, único
proceso que tiene la clave: **la clave cruda nunca llega al host ni al manifest**.

```bash
grep '^source_key_fingerprint=' <base>.manifest
```

| Situación | Resultado |
| --- | --- |
| La huella coincide | Continúa al descifrado |
| La huella **difiere** | Falla de inmediato, sin descifrar |
| Huella **ausente** (pre-M25.3) | Aviso y continúa; el descifrado verifica |
| No hay fuentes cifradas | `key_check_verified=false`, `reason=no_encrypted_sources` |

El último estado **no es un fallo ni un verde**: es un backup sin nada
verificable. Un restore con él no debe declararse plenamente bueno.

### Pasos antes de intentar un restore

1. **Localiza la clave** según la custodia D2. No la busques a fuerza bruta: el
   fingerprint dice si la que tienes es la correcta.
2. **Compara el fingerprint** con el del manifest antes de gastar tiempo.
3. **Verifica la longitud**: el restore exige ≥ 32 caracteres.
4. **Sin fingerprint en el manifest**, el descifrado real sigue verificando; no
   confíes solo en la longitud.
5. **Nunca imprimas la clave** en tickets, capturas, logs ni canales.

### Situaciones irrecuperables

| Situación | Recuperable |
| --- | --- |
| Clave perdida, ambas copias offline intactas | **Sí**, con custodia |
| Clave perdida, una copia intacta | **Sí**, con custodia |
| Clave perdida, ambas copias destruidas | **No.** `connection_config` es irrecuperable |
| Clave filtrada | **No** sin re-cifrar en sitio todas las fuentes (fuera de M25, D3) |
| Se rotó sin migrar | **No.** Sin versionado, lo anterior es ilegible |
| Fingerprint ausente y clave incorrecta | **No** para esas fuentes; el restore lo detecta al descifrar |

**Punto central:** la custodia depende de **disciplina operativa**, no de
infraestructura. No hay redundancia automática, ni rotación, ni envelope
encryption. ADR-002 D2 lo acepta de forma explícita.

### Relación con el bundle de restore

El bundle **excluye la clave de forma verificable**: el constructor falla si
encuentra `.env`, `SOURCE_ENCRYPTION_KEY`, `credentials` o `.b2-credentials`, y
`MANIFEST.bundle` lo declara con `contains_source_encryption_key=no`.

La clave llega por el canal de custodia, **fuera del bundle** y por un medio
independiente del de las credenciales de almacenamiento. Son custodios
complementarios: la credencial de lectura sin la clave no revela datos de fuentes
cifrados, y la clave sin el dump no recupera nada.

## 14. Pérdida completa del host

> **Estado de verificación.** El flujo está documentado y sus piezas existen, pero
> **no se ha ejecutado nunca de extremo a extremo**: no hay VPS de producción, ni
> cuenta de B2, ni ensayo de DR. Trátalo como un procedimiento que hay que ensayar,
> no como un camino probado.

### Los tres estados de este procedimiento

| Capacidad | Estado |
| --- | --- |
| Bundle portable, con digest de imagen y autoverificación | **M26.0, implementado y probado** |
| Cliente de subida off-host, con orden, reintentos y salida 76 | **M26.0, probado en contrato** |
| Bucket, objetos reales, descarga desde un host externo | **No existe** (requiere VPS y cuenta) |
| Recorrido completo hasta `restore=ok` en un host limpio | **Nunca ensayado** |

### Procedimiento

**1. Obtén un host limpio.** Ubuntu con Docker Engine y Compose v2. Verifica antes
de seguir:

```bash
docker --version && docker compose version
```

**2. Obtén el restore bundle** del commit que se quiere recuperar, y verifica su
integridad **antes** de extraerlo:

```bash
sha256sum restore-bundle-<fecha>-<commit>.tar.gz   # contra el checksum publicado
tar -xzf restore-bundle-<fecha>-<commit>.tar.gz
cd <directorio extraido>
sha256sum -c MANIFEST.bundle.sha256
```

Si la verificación falla, **para**: un bundle alterado no debe restaurar nada.

**3. Obtén el material de custodia**, por canales separados:

- `SOURCE_ENCRYPTION_KEY` (custodia D2, ver la sección 13).
- Contraseñas nuevas de la base destino y de los roles de runtime.
- `JWT_SECRET` nuevo: no hace falta reutilizar el anterior.

**4. Recupera el backup off-host** con la credencial de **solo lectura** (prefijo
`prod/`):

```bash
aws s3 cp --endpoint-url "$B2_S3_ENDPOINT" \
  s3://$BACKUP_BUCKET/backups/prod/<base>.dump      /restore/<base>.dump
aws s3 cp --endpoint-url "$B2_S3_ENDPOINT" \
  s3://$BACKUP_BUCKET/backups/prod/<base>.roles.sql /restore/<base>.roles.sql
aws s3 cp --endpoint-url "$B2_S3_ENDPOINT" \
  s3://$BACKUP_BUCKET/backups/prod/<base>.manifest  /restore/<base>.manifest
```

**5. Distingue un juego completo.** Los tres objetos comparten `base`. **El
`.manifest` es el commit lógico**: sin él, el juego está incompleto y no se
restaura, aunque existan el dump y los roles. Un upload interrumpido deja
exactamente ese estado.

Confirma que el manifest referencia los otros dos:

```bash
grep -E '^(dump_file|roles_file|dump_sha256|roles_sha256)=' /restore/<base>.manifest
```

**6. Verifica la integridad** contra el manifest, antes de tocar nada:

```bash
cd /restore
grep -E '^(dump_sha256|roles_sha256)=' <base>.manifest
sha256sum <base>.dump <base>.roles.sql
```

Compara los dígitos a mano. Un `checksum mismatch` significa que el conjunto **no**
corresponde a ese manifest: para, no intentes "reparar" nada.

**7. Prepara el entorno.** Define las variables obligatorias. El compose de
restore construye las imágenes salvo que le des digests:

```bash
export RESTORE_API_IMAGE=privaris-api@sha256:<64-hex>
export RESTORE_MIGRATE_IMAGE=privaris-migrate@sha256:<64-hex>
export RESTORE_POSTGRES_PASSWORD=...    # nueva para este despliegue
export RESTORE_APP_ROLE_PASSWORD=...   # nueva
export RESTORE_BG_ROLE_PASSWORD=...    # nueva
export RESTORE_JWT_SECRET=...          # >= 32 caracteres, nuevo
export RESTORE_SOURCE_ENCRYPTION_KEY=...  # por custodia, sección 13
```

**8. Valida la clave ANTES del restore**, para no gastar un restore completo en
descubrir que la clave es incorrecta:

```bash
grep '^source_key_fingerprint=' /restore/<base>.manifest
```

Calcula `sha256(sha256(clave))` con la clave que tienes y compárala. Si difieren,
**detente aquí**. Si el manifest no trae fingerprint, el propio restore lo
verificará al descifrar.

**9. Ejecuta el restore:**

```bash
RESTORE_CONFIRM=RESTORE bash scripts/ops/postgres-restore.sh \
  --backup /restore/<base>.dump
```

**10. Exige los criterios de aceptación.** `restore=ok` **no basta**. Además:

- `key_check_verified=true` (o el aviso honesto `no_encrypted_sources`),
- `key_check_fingerprint=match` cuando el manifest trae fingerprint,
- conteos coincidentes con el manifest,
- `RLS verification` cubriendo las 7 tablas, con `bypassrls` correcto en
  `app_role` (f) y `bg_role` (t),
- `migration-count` coincidente.

**11. Verifica el servicio recuperado:**

```bash
docker compose -p <project> -f scripts/ops/docker-compose.restore.yml ps
curl -i http://localhost:18080/api/livez     # 200
curl -i http://localhost:18080/api/readyz    # 200
```

**12. Decide el cutover.** El cambio de tráfico es una decisión de operador, no del
script. Usa `RESTORE_KEEP=1` para inspeccionar antes de limpiar:

```bash
docker compose -p <project> -f scripts/ops/docker-compose.restore.yml \
  down --volumes --remove-orphans
```

### Si algo falla

| Síntoma | Dónde mirar |
| --- | --- |
| `docker: command not found` / Compose v1 | Instala Docker + Compose v2 antes de empezar |
| `roles export not found` | Faltan los tres artefactos; vuelve al paso 5 |
| `checksum mismatch` | Sección 9 |
| `SOURCE_ENCRYPTION_KEY does not match this backup` | Sección 13 y paso 8 |
| `decryption failed` | Sección 13: clave incorrecta sin fingerprint en el manifest |
| `key_check_verified=false` + `no_encrypted_sources` | Estado honesto, no un fallo; pero no es un verde pleno |
| Imágenes no descargables | Disponibilidad del registry, no del bundle |

### Lo que este procedimiento NO cubre

- **PITR / WAL**: no existe. El RPO real es la frecuencia del backup completo.
- **Alertas**: si la subida falla con `76` y nadie mira el log, la pérdida pasa
  inadvertida (sección 12).
- **Alta disponibilidad**: ADR-002 D0 asume un único VPS; no hay réplicas.
- **Multi-región**: la cuenta de B2 tiene una única región.
