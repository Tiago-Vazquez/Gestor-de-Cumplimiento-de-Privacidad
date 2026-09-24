# @workspace/api-server

API Express 5 + PostgreSQL (Drizzle ORM) del Gestor de Cumplimiento de Privacidad.

```bash
pnpm build        # build con esbuild
pnpm start        # node --enable-source-maps ./dist/index.mjs
pnpm typecheck    # tsc --noEmit
pnpm test         # vitest run
```

## Variables de entorno

El arranque es **fail-fast**: `assertAuthConfigForEnv()` (en `src/auth/tokens.ts`, invocado desde `src/index.ts`) aborta el startup ante configuración insegura. Los flags booleanos usan comparación estricta (`"true"`/`"1"`); nunca se acepta `"TRUE"`, `"yes"` ni valores vacíos como habilitadores.

### `JWT_SECRET` (obligatorio)

- Secreto HS256 para firmar/verificar los JWT de sesión.
- **Mínimo 32 caracteres.** Con la autenticación activa, ausente, vacío, solo espacios o <32 chars **abortan el arranque** (hardening 6.3B.21); sin esto, el servidor arrancaría y fallaría recién en el primer request.
- La excepción es el bypass de desarrollo (ver `AUTH_DISABLED`): en ese modo no se firma ni verifica ningún JWT y el secret no se exige al arrancar.
- Generación: `node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"`.
- Nunca se loguea ni se expone en respuestas.

### `AUTH_DISABLED` (default: deshabilitado — fail-closed)

- `true`/`1` desactiva la autenticación e inyecta la identidad `dev-sub` con rol admin. **Solo para dev/test.**
- En producción (`NODE_ENV=production`) el arranque **aborta** si está activo, y `authDisabled()` devuelve `false` igualmente (defensa en profundidad: el middleware ignora el bypass aunque la variable llegue al entorno).
- Cualquier otro valor (incluido `"TRUE"`) mantiene la autenticación activa.

### `AUTH_REGISTRATION_ENABLED` (default: deshabilitado — opt-in)

- Solo `true`/`1` habilita el registro público `POST /api/auth/register` (rol inicial `auditor`).
- Ausente/deshabilitado → 401 uniforme **antes** de consultar repositorios: no crea usuario, no asigna roles, no crea sesión, no emite JWT y no revela si un email existe.
- El login de usuarios existentes **no** se ve afectado por este flag.
- Rate limit dedicado: 10 requests / 15 min por IP.

### `JWT_EXPIRES_IN` (default: 28800)

- Duración del JWT en **segundos** (default 8 horas). Valor no numérico o ≤0 → fallback 8h.

### `TRUST_PROXY` (default: `false` — fail-closed)

- Valor de Express `trust proxy`: `true`/`false`, número de saltos (p. ej. `1`) o expresión de proxy/CIDR.
- **Default `false`**: `req.ip` refleja siempre el socket peer y NO puede spoofearse vía `X-Forwarded-For` (hardening 6.3B.23, F23-01). Los rate limiters usan `req.ip` como parte de su clave.
- Despliegues detrás de reverse proxy (load balancer, CDN, router de Replit) DEBEN habilitarlo explícitamente con `TRUST_PROXY=true|1|<n>`. Sin configurar, los rate limiters verían la IP del proxy y clientes bajo NAT compartido compartirían bucket.

### `CORS_ORIGINS` (default: unset)

- Lista separada por comas de orígenes permitidos (p. ej. `https://app.example.com,https://admin.example.com`).
- **Unset = same-origin only**: no se emiten cabeceras CORS y el navegador bloquea los cross-origin.
- Nunca `*` en producción: la sesión viaja en cookie (`httpOnly`, `sameSite=lax`, `secure` en producción) y las credenciales exigen origen exacto.

## Provisioning del primer administrador (M22)

El bootstrap legacy (`AUTH_BOOTSTRAP_TOKEN` / identidad fija `bootstrap-admin`)
fue **eliminado** en M22. Una instalación nueva crea su primer administrador con
una operación administrativa explícita (fuera del flujo HTTP):

```bash
ADMIN_DATABASE_URL='postgresql://privacy:...@db:5432/privacy' \
PROVISION_ADMIN_EMAIL='admin@example.com' \
PROVISION_ADMIN_PASSWORD='...' \
pnpm --filter @workspace/db run db:provision-admin
```

Esto crea la primera organización + el usuario admin (hash scrypt) + rol global
`admin` + membership `owner`. Luego el admin inicia sesión con email + password.
Idempotente: re-ejecutable sin duplicar.

## Conexiones de base de datos (3 roles)

| Variable | Rol | Uso |
|---|---|---|
| `DATABASE_URL` | `app_role` (NOBYPASSRLS) | API HTTP |
| `BG_DATABASE_URL` | `bg_role` (BYPASSRLS) | scanner/scheduler/recovery |
| `ADMIN_DATABASE_URL` | `privacy` (superuser) | migraciones + provisioning |

Las contraseñas de `app_role`/`bg_role` **no** están hardcodeadas: la migración
`0019` las deja en `NULL` y `db:provision-roles` las fija desde
`APP_ROLE_PASSWORD`/`BG_ROLE_PASSWORD` (secretos externos del entorno).

## Rate limiting (in-memory)

| Endpoint | Límite | Ventana |
|---|---|---|
| `POST /api/auth/login` (local) | 5 | 15 min por IP |
| `POST /api/auth/register` | 10 | 15 min por IP |

Almacenamiento en memoria de proceso: válido para una instancia. Despliegues multi-instancia requieren un store compartido (p. ej. Redis) — trabajo pendiente documentado (F17).

## Seguridad

- `helmet()` activo; cookie de sesión `httpOnly` + `sameSite=lax` + `secure` en producción.
- `requireAuth` exige JWT válido + `jti` + fila de sesión activa en allowlist; los cambios de rol revocan sesiones en la misma transacción; el login crea sesión transaccionalmente con lock de fila.
- Listados paginados server-side (`limit` default 50, máx 100, `offset` ≥ 0) aplicados en SQL.
