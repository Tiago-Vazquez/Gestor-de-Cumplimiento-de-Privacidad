# Security Overview

Postura de seguridad del Gestor de Cumplimiento de Privacidad, escrita para una
evaluacion tecnica. **Cada afirmacion apunta a un fichero y a codigo real.**

> Este documento **no** afirma certificacion, cumplimiento legal ni estandar
> alguno (SOC 2, ISO 27001, RGPD). No existe tal certificacion.

## 1. Arquitectura de seguridad

La defensa se apoya en el servidor, no en el cliente. El frontend nunca decide
permisos: la UI oculta acciones, pero la autorizacion real vive en la API y en
PostgreSQL.

```
Navegador
  |  cookie de sesion (httpOnly) + cabecera CSRF en mutaciones
  v
Express: helmet -> CORS allowlist -> requireAuth -> org-context
  |
  v
Repositorios: tenant scoping explicito por consulta
  |
  v
PostgreSQL: RLS con app.current_tenant (fail-closed)
```

## 2. Autenticacion

| Control | Implementacion | Evidencia |
| --- | --- | --- |
| Contrasena con hash | scrypt, sal aleatoria por usuario | `lib/auth/src/password.ts` |
| Firma de token | JWT con `jti` y expiracion | `artifacts/api-server/src/auth/tokens.ts` |
| Sesiones revocables | El `jti` debe existir en `sessions` | `auth/middleware.ts:68-69` |
| Expiracion por inactividad | `SESSION_IDLE_SECONDS` | `.env.example` |
| Password de >= 32 caracteres en `SOURCE_ENCRYPTION_KEY` | Fail-closed en produccion | `lib/.../secret-manager.ts:32-46` |
| Kill switch de registro | `AUTH_REGISTRATION_ENABLED` | `routes/auth.ts:266` |
| Provisioning de admin | Script idempotente, fuera del flujo HTTP | `lib/db/src/provision-admin.ts` |
| Recuperacion de contrasena | Token aleatorio de 32 bytes, solo SHA-256 en BD | `repositories/password-reset.repo.ts` |

### 2.1 Recuperacion de contrasena (M30.0)

Flujo de dos endpoints sin sesion: **el token es la credencial**.

| Control | Decision |
| --- | --- |
| Token | `randomBytes(32)` en base64url (256 bits). En BD solo su SHA-256 (`token_hash`, indice unico). El token en claro nunca se persiste ni se registra. |
| TTL | 1 hora (`PASSWORD_RESET_TTL_MS`). Pedir un reset nuevo invalida los pendientes anteriores del usuario. |
| Anti-enumeracion | `POST /api/auth/password/forgot` responde **siempre** 202 con el mismo cuerpo, exista o no la cuenta. Un fallo del canal de entrega tampoco cambia la respuesta. |
| Fallo indistinguible | `POST /api/auth/password/reset` responde el mismo 400 (`Invalid or expired reset token`) para token inexistente, expirado o ya usado. |
| Consumo unico | `consumed_at` con `SELECT ... FOR UPDATE` + `IS NULL` en una transaccion que cambia la contrasena, revoca **todas** las sesiones del usuario y consume el token. Un fallo hace ROLLBACK. |
| Rate limiting | Buckets propios y aislados: `forgot` 5/15min, `reset` 10/15min, con clave IP + email normalizado (mismo criterio que `loginLimiter`, para no aislar a una victima). |
| Politica de contrasena | Reutiliza `isValidPassword`, la misma que registro y `password/change`. |

**Entrega**: no hay SMTP. El enlace sale por un seam, `PASSWORD_RESET_DELIVERY_CMD`, que
recibe el payload por **stdin** (mismo enfoque que `ALERT_CMD`). En desarrollo,
`PASSWORD_RESET_DELIVERY_CMD=cat` imprime el enlace. Si el comando falla, se registra
pero el endpoint **no** cambia de respuesta: un canal roto no puede convertirse en un
`500` que delate si la cuenta existe. `PASSWORD_RESET_BASE_URL` permite fijar la base
del enlace en produccion.

`SOURCE_ENCRYPTION_KEY` ausente o corta **aborta el arranque** en produccion; en
desarrollo emite warning y continua.

## 3. Autorizacion y RBAC

- Roles: `admin` y `auditor` (`user_roles`, `memberships`).
- La UI tiene una guarda (`pages/users.tsx:12-29`); el comentario del propio
  codigo dice que **la proteccion real la aplica el backend**.
- Mutaciones de roles pasan por el servidor, que impide retirar el rol `admin`
  al ultimo administrador y a uno mismo.

## 4. Multi-tenancy — tres capas

| Capa | Evidencia |
| --- | --- |
| Resolucion de organizacion en HTTP | `auth/org-context.ts` |
| Scoping en repositorios | `tenantScopeStrict` / `isNull(tenantId)` en 8 repositorios |
| RLS en PostgreSQL | `lib/db/drizzle/0018_rls_tenant_policies.sql` |

El fail-closed: `current_setting('app.current_tenant', true)` devuelve NULL si
el contexto no esta fijado, y `tenant_id = NULL` no matchea ninguna fila. Es
decir, **el olvido de fijar el contexto produce cero resultados, no todos**.

Tests dedicados: `tenant-isolation`, `tenant-strict-scoping`, `users-rbac-negative`,
`background-isolation`, `connectors-isolation`.

## 5. Roles de base de datos

```sql
ALTER ROLE app_role NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;  -- 0018:33
ALTER ROLE bg_role  NOSUPERUSER NOCREATEDB NOCREATEROLE BYPASSRLS;     -- 0018:35
```

- `app_role` lo usa la API: sujeto a RLS, sin bypass.
- `bg_role` lo usan tareas internas (scanner, limpieza de sesiones): bypass
  deliberado y con grants minimos, tabla por tabla (`0018:45-57`).
- Las contrasenas de ambos roles las inyecta `provision-roles.ts` desde el
  entorno; las migraciones (0019) las dejan en `PASSWORD NULL`.

## 6. Proteccion IDOR

Las respuestas nunca exponen identificadores de recurso de otro tenant:

- scoping en repositorio por organizacion resuelta en la sesion;
- RLS como red de seguridad en la base de datos;
- validacion de entrada con zod en cada ruta (contratos generados en
  `lib/api-zod`).

## 7. CSRF

Token en cookie, verificado en mutaciones (`auth/csrf.ts`). Las violaciones se
auditan, pero **solo con sesion resuelta**, para no ampliar registros anonimos.
Tests: `csrf.test.ts`.

## 8. CORS

Fail-closed. Sin `CORS_ORIGINS` declarado, no se emite ningun header CORS y solo
se sirve same-origin (`app.ts:43-45`, `app.ts:171-181`). El comentario del
codigo lo dice: *Never "*" in production*.

## 9. Headers y proxy

- `helmet()` montado en `app.ts:168`.
- `trust proxy` **no** se toma del entorno a ciegas: se parsea
  `TRUST_PROXY` explicitamente (`app.ts:29`, `app.ts:116`). Existe porque un
  `true` generico rompe los rate limiters por IP tras un proxy.

## 10. Manejo de errores

`middlewares/error-handler.ts:11-13`: los stack traces y el detalle interno
**nunca** llegan al cliente en produccion. Fuera de produccion el mensaje si se
incluye para acelerar el desarrollo. Las respuestas usan `problem+json`.

## 11. Cifrado de credenciales de fuentes

- AES-256-GCM, formato `iv:tag:ciphertext` en base64.
- Clave derivada por SHA-256 de `SOURCE_ENCRYPTION_KEY`; la clave cruda nunca
  se almacena.
- Fail-closed si no esta configurada (`secret-manager.ts:51-55`).
- El bundle de restore **excluye** la clave de forma verificable
  (`MANIFEST.bundle` declara `contains_source_encryption_key=no`), y la
  verificacion de restore **descifra de verdad** una credencial almacenada.

## 12. Rate limiting

Limiters dedicados y separados por namespace: `login` (5 / 15 min),
`register` (10 / 15 min), `password-change`, y limiters globales de API.
Store persistente opcional (`AUTH_RATE_LIMIT_STORE=postgres`) para que los
contadores sobrevivan a reinicios.

## 13. Auditoria

Trail con actor, accion, recurso, resultado y `requestId`. Sanitizado: los
valores rechazados **no** se persisten (verificado en
`security-hardening.test.ts`, caso "password_too_long").

## 14. Backup y restore

- Backup logico con checksums, conteos por tabla, journal de migraciones y
  huella de la clave.
- Restore que verifica RLS, roles, journal y **descifra** una credencial.
- Bundle sin secretos, por digest.
- CI ejecuta un DR drill real en cada push.

## 15. Gates de CI

| Gate | Que bloquea |
| --- | --- |
| Typecheck (libs, API, frontend) | Errores de tipos |
| Build de producto | Build roto |
| Tests API + frontend | Regresion funcional |
| `test:ops` | Regresion en scripts operativos |
| `pnpm audit --audit-level high` | Vulnerabilidades high/critical |
| Conectores con PostgreSQL y MySQL reales | Conector roto |
| DR drill completo | Backup/restore roto |

Workflow con `permissions: contents: read` y actions fijadas por SHA.

## 16. Tests de seguridad

`security.test.ts`, `security-hardening.test.ts`, `csrf.test.ts`,
`tenant-isolation.test.ts`, `tenant-strict-scoping.test.ts`,
`users-rbac-negative.test.ts`, `error-handler.test.ts`, `secret-manager.test.ts`,
`problem-json.test.ts`.

## 17. Limitaciones actuales

**Implementado**: aislamiento multi-tenant, RLS, separacion de roles, sesiones
revocables, CSRF, CORS fail-closed, cifrado de credenciales, auditoria,
rate limiting, backup/restore verificado.

**Parcial**:
- Alertas de backup: el seam generico `ALERT_CMD` esta **implementado y probado** (R9c). El
  backup programado y el uploader notifican `partial_upload_failed` cuando la subida
  off-host falla, y `skipped_locked`/`failed` cuando falla el backup local. **No hay
  canal desplegado ni servidor**: sin definir `ALERT_CMD` en un entorno real, un backup
  fallido no notifica a nadie. No hay stack de monitorizacion mas alla de metricas,
  logs estructurados y probes.
- Backup: hay scheduler en codigo, **implementado y probado** (R9a, contrato
  `ops:backup-schedule` + unidades systemd). No hay VPS ni entorno de produccion, asi
  que hoy se ejecuta **manualmente**.

**Pendiente**:
- **MFA**: no implementado. Login solo por email + contrasena.
- **TLS / reverse proxy / dominio**: no incluidos en el repositorio.
- **Recuperacion de contrasena**: **implementada y probada** (M30.0) en cuanto al
  modelo, los endpoints, la UI y los tests. Lo que **no** existe es el transporte:
  sin un proveedor de correo configurado en `PASSWORD_RESET_DELIVERY_CMD` el enlace
  no sale a nadie. El seam existe precisamente para no atar el flujo a un proveedor.

**Aprobado e implementado**:
- **Politica de `complianceScore`**: **aprobada** (`docs/adr/ADR-004`) e
  **implementada**. Es una politica ponderada por severidad
  (`low` 1, `medium` 3, `high` 7, `critical` 15) sobre los hallazgos **abiertos**
  de la organizacion: `max(0, 100 - penalizacion)`, con piso en `0` y resultado
  entero. Ya no es el `100 / 0` provisional. El calculo vive aislado en
  `compliance-score.ts` y no altera el contrato de la API.
- No es una certificacion ni un porcentaje legal de cumplimiento: mide carga de
  hallazgos abiertos por severidad.

**Dependiente de infraestructura externa**:
- **Backblaze B2, Object Lock, lifecycle**: bloqueados hasta que exista un VPS.
  La region de B2 **es irreversible** al crear la cuenta.
- **PITR / WAL**: definido (ADR-002 D5), sin implementar.
- **Recuperacion ante perdida de host**: no probada; requiere un segundo host.
- **Alta disponibilidad / replicas**: fuera de alcance (ADR-002 D0, un VPS).