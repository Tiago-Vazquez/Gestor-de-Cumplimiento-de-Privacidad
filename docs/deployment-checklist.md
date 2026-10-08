# Master Production Deployment Checklist — Privaris

> **M44.1 — checklist operativa consolidada (solo documentación).**
> No ejecuta nada. Cada casilla se marca únicamente cuando el operador aporta
> evidencia real. Esta checklist **no duplica el "cómo"**: remite a
> `DEPLOY.md`, `docs/operations-runbook.md`, `.env.example`,
> `docs/security-overview.md` y los ADR.
>
> `PENDIENTE DE DEFINIR EN DEPLOYMENT` = falta una decisión del operador; **no
> inventarla**. Las fases A→G son secuenciales salvo indicación contraria.

## FASE A — Infraestructura

### A.1 VPS

- [ ] VPS aprovisionado (proveedor, precio y región fuera del alcance de este repo).
- [ ] SO Linux con Docker Engine soportado (toolchain del repo: Node 22, pnpm 10 —
  ver `docs/ci.md`). `PENDIENTE DE DEFINIR EN DEPLOYMENT`: distro/versión exacta
  del host; el repositorio no la fija.
- [ ] Acceso SSH con llave pública (no contraseña), usuario no-root con `sudo`.
- [ ] Reloj/hora sincronizada (NTP) — relevante para TLS, JWT y timestamps de backup.

### A.2 Docker

- [ ] Docker Engine instalado y en ejecución (`docker info` OK).
- [ ] Docker Compose **v2** (`docker compose version`), no `docker-compose` v1.
- [ ] Usuario de despliegue autorizado a usar Docker (grupo `docker` o rootless).
- [ ] `docker compose config` válido sobre el repositorio clonado en el VPS.

### A.3 Almacenamiento

- [ ] Volumen Docker `pgdata` persistente (lo crea compose; nunca `down -v` en prod).
- [ ] `BACKUP_DIR` creado **fuera del repositorio y fuera del host Docker** (ver
  `.env.example`; el script rechaza directorios dentro del repo salvo drill).
- [ ] Espacio en disco suficiente para `pgdata` + staging local de backups (≥3 días).

### A.4 Red / firewall

- [ ] Firewall: públicos solo `22` (SSH), `80`, `443`.
- [ ] `5000` (api) y `8080` (web) **no alcanzables desde Internet** (re-mapear a
  `127.0.0.1` en compose o bloquear en firewall).
- [ ] `5432` (postgres) nunca expuesto; solo interno de la red Docker.

### A.5 Dominio / DNS

- [ ] Dominio registrado. `PENDIENTE DE DEFINIR EN DEPLOYMENT`: nombre.
- [ ] Registro DNS `A`/`AAAA` → IP pública del VPS.
- [ ] Mismo origen para web+API (recomendado) → `CORS_ORIGINS` vacío.

## FASE B — Secretos y configuración

Referencia: `.env.example` y `DEPLOY.md` → "Variables". Generar con
`openssl rand -base64 48` donde se indique. **Nunca versionar valores reales.**

Clasificación: **O**bligatoria · **Op**cional · **G**enerada por operador ·
**D**erivada (compuesta) · **N**o rotable · **R**otable.

| Variable | Req. | Clase | Rotable | Notas |
| --- | --- | --- | --- | --- |
| `POSTGRES_USER` | O | fija | N | `privacy` |
| `POSTGRES_PASSWORD` | O | G | R | superusuario `privacy` |
| `POSTGRES_DB` | O | fija | N | `privacy` |
| `APP_ROLE_PASSWORD` | O | G | R | rol HTTP `app_role` (NOBYPASSRLS) |
| `BG_ROLE_PASSWORD` | O | G | R | rol bg `bg_role` (BYPASSRLS) |
| `DATABASE_URL` | O | D | — | compuesta por compose (app_role) |
| `BG_DATABASE_URL` | O | D | — | compuesta por compose (bg_role); fail-closed si falta |
| `ADMIN_DATABASE_URL` | O¹ | D | — | superusuario; solo migraciones/provision-admin |
| `JWT_SECRET` | O | G | R | ≥32 chars, fail-fast |
| `SOURCE_ENCRYPTION_KEY` | O | G | **N** | secreto de por vida (ADR-002 D3); cifra fuentes |
| `RESEND_API_KEY` | Op² | G | R | secreto; sin ella no hay entrega de email |
| `PASSWORD_RESET_FROM` | Op² | config | R | remitente aceptado por Resend |
| `PASSWORD_RESET_BASE_URL` | O³ | config | — | base pública del enlace (detrás de proxy) |
| `TRUST_PROXY` | O | config | — | `1` (un salto: Caddy) |
| `CORS_ORIGINS` | Op | config | — | vacío con mismo origen |
| `NODE_ENV` | O | fija | N | `production` |
| `API_PORT` / `WEB_PORT` | fija | config | N | 5000 / 8080 |
| `AUTH_RATE_LIMIT_STORE` | Op | config | — | `memory` (o `postgres`) |
| `AUTH_REGISTRATION_ENABLED` | Op | config | — | `false` en prod |
| `SESSION_IDLE_SECONDS` | Op | config | — | default 1800 |
| `HEALTHCHECK_DB` | Op | config | — | default true |
| `PROVISION_ADMIN_EMAIL` | O¹ | config | — | una vez (primer admin) |
| `PROVISION_ADMIN_PASSWORD` | O¹ | G | R | una vez |
| `BACKUP_DIR` | O | config | — | fuera del repo/host Docker |
| `BACKUP_RETENTION_DAYS` | Op | config | — | default **3** (staging local) |
| `BACKUP_LOCK_GRACE_SECONDS` | Op | config | — | default 120 |
| `BACKUP_BUCKET` | O⁴ | config | N | nombre global único B2 |
| `B2_S3_ENDPOINT` | O⁴ | config | N | por cuenta (no derivable de región) |
| `B2_S3_REGION` | O⁴ | config | N | región de firma SigV4 |
| `B2_WRITE_KEY_ID` | O⁴ | G | R | app key write (caduca 180 días) |
| `B2_WRITE_SECRET_KEY` | O⁴ | G | R | sin deleteFiles/bypassGovernance |
| `B2_READ_KEY_ID` | O⁵ | G | R | solo lectura, prefijo `prod/` |
| `B2_READ_SECRET_KEY` | O⁵ | G | R | **no reside en el VPS**; fuera de banda |
| `BACKUP_PREFIX` | Op | config | N | `prod` (un segmento) |
| `OFFHOST_UPLOAD_RETRIES` | Op | config | — | default 3 |
| `OFFHOST_UPLOAD_RETRY_DELAY_SECONDS` | Op | config | — | default 5 |
| `ALERT_CMD` | O⁶ | config | R | comando que recibe JSON por stdin |

¹ Solo para instalación nueva / provisioning. ² Solo si se habilita recovery por email.
³ Obligatoria detrás de reverse proxy/dominio. ⁴ Para off-host (FASE F).
⁵ Para restore off-host / DR. ⁶ Obligatoria para que un fallo de backup avise a alguien.

Notas:

- `SOURCE_ENCRYPTION_KEY` **no rota** (ADR-002 D3): rotarla sin migración deja
  ilegibles todas las fuentes cifradas. Custodia separada de B2 (ADR-002 D2).
- `JWT_SECRET` sí rota (invalida sesiones); es decisión distinta de la clave de cifrado.
- `OFFHOST_S3_CMD` (ADR-003) es un override de contrato para tests; no es variable
  de producción.

## FASE C — Reverse proxy / TLS

Topología (DEPLOY.md "TLS y reverse proxy"):

```text
Internet → :443 (Caddy, termina TLS) → /      → web:8080
                                      → /api/* → api:5000 (un solo salto)
```

- [ ] DNS resuelve el dominio a la IP del VPS.
- [ ] Puertos `80` (redirección ACME) y `443` abiertos.
- [ ] Caddy instalado en el VPS (la config vive en el VPS, no en el repo).
- [ ] TLS vía Let's Encrypt, renovación automática (sin certificado manual).
- [ ] `/` y resto del SPA → `web:8080`.
- [ ] `/api/*` → `api:5000` **directo** (sin pasar por el nginx de `web`).
- [ ] Cabeceras `X-Forwarded-For`, `X-Forwarded-Proto: https`, `X-Forwarded-Host`.
- [ ] `TRUST_PROXY=1` (exactamente un salto; revisar si se añade CDN/LB delante).
- [ ] Cookies `Secure` activas (`NODE_ENV=production`, automático).
- [ ] `PASSWORD_RESET_BASE_URL=https://<dominio>` explícita.
- [ ] Healthchecks vía proxy: `https://<dominio>/api/livez`, `/api/readyz`, `/healthz`.
- [ ] `CORS_ORIGINS` vacío (mismo origen).

## FASE D — Primer deployment (orden exacto)

Referencia: DEPLOY.md "Arranque" y "Flujo de arranque". Los pasos 5–9 los
materializa `docker compose up --build -d` respetando dependencias
(`db` healthy → `migrate` one-shot → `api` → `web`); se listan por separado
para verificación explícita.

- [ ] **1. Preparar host:** SO, SSH, NTP, firewall (FASE A).
- [ ] **2. Configurar Docker:** Engine + Compose v2 + usuario autorizado.
- [ ] **3. Preparar almacenamiento:** volumen `pgdata` y `BACKUP_DIR` fuera del repo.
- [ ] **4. Preparar `.env`:** copiar `.env.example` → `.env`, completar secretos
  (FASE B), permisos `600`, fuera de git.
- [ ] **5. Levantar DB:** `db` healthy (`pg_isready`).
- [ ] **6. Ejecutar migraciones:** job `migrate` termina `completed_successfully`
  (`db:migrate && db:provision-roles`); verificar `drizzle.__drizzle_migrations`
  con 24 entradas (0000–0023).
- [ ] **7. Verificar roles/RLS:** `app_role` (NOBYPASSRLS) y `bg_role` (BYPASSRLS)
  provisionados; RLS `ENABLE`+`FORCE` en las 7 tablas de la migración 0018.
- [ ] **8. Levantar API:** `api` healthy (user no-root), `/api/livez` 200.
- [ ] **9. Levantar web:** `web` healthy, SPA servida, `/healthz` OK.
- [ ] **10. Verificar healthchecks:** `livez` 200, `readyz` 200 (BD), `/healthz` 200.
- [ ] **11. Configurar Caddy/TLS:** Caddyfile (`/`→8080, `/api/*`→5000).
- [ ] **12. Verificar HTTPS:** certificado emitido; `https://<dominio>` navega; API
  responde por `https://<dominio>/api/*`; `livez`/`readyz` por HTTPS.
- [ ] **13. Configurar scheduler:** timer systemd `backup-schedule.timer` (runbook §12).
- [ ] **14. Configurar backup:** `pnpm run ops:backup` manual → dump+roles+manifest
  y `result=ok` (exit 0).
- [ ] **15. Configurar off-host:** `pnpm run ops:offhost-upload` → 3 objetos en B2,
  manifest al final (exit 0); verificar retención/lifecycle (90 días).
- [ ] **16. Configurar alerting:** `ALERT_CMD` definido; validar que un `76` y un
  `failed` disparan la alerta (runbook §12).
- [ ] **17. Configurar Resend:** `RESEND_API_KEY` + `PASSWORD_RESET_FROM` +
  `PASSWORD_RESET_BASE_URL`; probar flujo completo (FASE E).
- [ ] **Provisionar primer admin** (una vez): `db:provision-admin` con
  `ADMIN_DATABASE_URL`, `PROVISION_ADMIN_EMAIL`, `PROVISION_ADMIN_PASSWORD`.

## FASE E — Validación funcional

**Obligatorias** (bloquean GO): login, logout, sesiones, autorización por
organización, roles, reglas, scans, findings, compliance score, reports,
frontend/API, healthchecks, password recovery (flujo token+reset).

**Opcionales**: entrega de email vía Resend (solo si se habilita), métricas.

- [ ] **Login** (O): email+password válidos → 200 + cookie httpOnly + sesión con `jti`.
- [ ] **Logout** (O): revoca sesión en DB; cookie limpiada; `jti` invalidado.
- [ ] **Sesiones** (O): listado `/api/auth/sessions` solo del usuario; revocación
  individual y `logout-all`; expiración por inactividad.
- [ ] **Autorización por organización** (O): un usuario de la org A no ve datos de la
  org B (tenant scoping + RLS).
- [ ] **Roles** (O): admin de org vs. miembros; accesos administrativos gated por rol.
- [ ] **Password recovery** (O): `forgot` → 202 indistinguible; `reset` con token
  válido cambia password y revoca sesiones; token reutilizado → 400; token expirado → 400.
- [ ] **Resend** (Op): `forgot` entrega email real con enlace `PASSWORD_RESET_BASE_URL`
  correcto (solo si se configuró Resend).
- [ ] **Reglas** (O): CRUD por `key`, toggle `enabled`, identidad por `key`.
- [ ] **Scans** (O): crear/ejecutar/finalizar scan; deltas por regla; lifecycle correcto.
- [ ] **Findings** (O): listado excluye superseded; deduplicación entre scans.
- [ ] **Compliance score** (O): cálculo por severidad (ADR-004), piso 0, entero.
- [ ] **Reports** (O): endpoints definidos y usados por el frontend.
- [ ] **Frontend/API** (O): SPA sirve en `https://<dominio>`; API responde por
  `https://<dominio>/api/*`; sin CORS.
- [ ] **Healthchecks** (O): `/api/livez` 200 sin BD; `/api/readyz` 200 con BD;
  `/healthz` 200.
- [ ] **Métricas** (Op): `GET /api/metrics` expone contadores/gauges/histogramas
  (sin datos de negocio); restringir a scraper vía firewall/proxy.

## FASE F — Backup y DR

### IMPLEMENTADO EN REPO (no requiere acción de código)

- [ ] `scripts/ops/postgres-backup.sh` — dump custom + roles + manifest (checksums SHA-256).
- [ ] `scripts/ops/postgres-restore.sh` — verifica checksums, RLS (7 tablas), roles,
  `SOURCE_ENCRYPTION_KEY` (fingerprint + descifrado real), conteos, migraciones.
- [ ] `scripts/ops/offhost-upload.sh` — subida a S3 (B2) con `76` en fallo parcial.
- [ ] `scripts/ops/backup-schedule.sh` + `.service`/`.timer` — scheduler local.
- [ ] `scripts/ops/build-restore-bundle.sh` — bundle por digest, sin secretos.
- [ ] `ALERT_CMD` (seam de alertas: `ok|skipped_locked|failed|partial_upload_failed`).
- [ ] CI: `test:ops` + DR drill en cada push.

### CONFIGURACIÓN DEL OPERADOR

- [ ] Timer systemd `backup-schedule.timer` instalado/activado.
- [ ] Segundo timer off-host (runbook §12) para `offhost-upload` después del backup.
- [ ] Cuenta B2: bucket, Object Lock (Governance 30 días), lifecycle (90 días),
  app keys write/read.
- [ ] `ALERT_CMD` apuntando a un canal real (email/webhook).
- [ ] `SOURCE_ENCRYPTION_KEY` bajo custodia separada (ADR-002 D2), fuera del host y
  del bucket; copia offline verificada periódicamente.

### PRUEBA REAL PENDIENTE (requiere VPS + B2)

- [ ] Backup local real → `result=ok`, manifest con `source_key_fingerprint`.
- [ ] Off-host upload real → 3 objetos, manifest al final, `exit 0`.
- [ ] Simular fallo de subida → `exit 76` y alerta `partial_upload_failed`.
- [ ] Restore real (proyecto aislado) → `restore=ok`, `key_check_verified=true`,
  conteos y RLS OK.
- [ ] DR drill "pérdida de host" (runbook §14) con bundle por digest.
- [ ] Rotación de app keys B2 (write, 180 días) sin romper backups.

## FASE G — GO / NO-GO

**GO** solo si TODAS las casillas siguientes están verificadas con evidencia:

- [ ] HTTPS funciona (certificado válido, sin errores de certificado).
- [ ] API y web funcionan por HTTPS (login y navegación reales).
- [ ] DB `healthy` y `readyz` 200.
- [ ] Migraciones correctas (24 entradas; sin divergencia).
- [ ] RLS verificado (7 tablas; `app_role` NOBYPASSRLS, `bg_role` BYPASSRLS).
- [ ] Login funciona.
- [ ] Autorización por organización funciona (aislamiento tenant).
- [ ] Password recovery funciona (token válido cambia password; token reusado falla).
- [ ] Backup funciona (`result=ok`).
- [ ] Off-host funciona (`exit 0`, manifest al final).
- [ ] Alerting funciona (un `76`/`failed` dispara alerta).
- [ ] `SOURCE_ENCRYPTION_KEY` bajo custodia correcta (fuera del host y del bucket).
- [ ] Restore validado (probes 200 + conteos + RLS + descifrado real).
- [ ] DR mínimo validado (bundle o pérdida de host simulada).
- [ ] Sin hallazgos BLOCKER/HIGH/MEDIUM abiertos.

**NO-GO** si cualquiera de las anteriores falla o está sin evidencia. En ese caso:
detener, registrar el hallazgo con evidencia, y **no** cortar tráfico a producción.

## Referencias (fuente de autoridad)

- `DEPLOY.md` — arranque, flujo, TLS/reverse proxy, variables, primer admin, backup/DR.
- `docs/operations-runbook.md` — incidentes y procedimientos (backup §12, clave §13,
  pérdida de host §14, restore §6–11).
- `.env.example` — variables y defaults.
- `docs/security-overview.md` — postura y límites.
- `docs/adr/ADR-002` (backup/DR) y `docs/adr/ADR-003` (off-host B2) — decisiones D0–D6.
