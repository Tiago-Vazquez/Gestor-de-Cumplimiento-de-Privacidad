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

### `AUTH_BOOTSTRAP_ENABLED` (default: deshabilitado — opt-in)

- Solo `true`/`1` habilita el login bootstrap (`POST /api/auth/login` con `{ token }` contra `AUTH_BOOTSTRAP_TOKEN`), que usa la identidad fija `bootstrap-admin` con rol admin.
- Ausente, vacío, `"false"`, `"0"`, `"TRUE"` o cualquier typo → deshabilitado (401 uniforme, sin tocar repos ni emitir JWT).
- Si se habilita en producción, se registra una advertencia en el log de arranque. Flujo **legacy**: pendiente de eliminación una vez exista provisioning alternativo (TODO en `src/routes/auth.ts`).
- `AUTH_BOOTSTRAP_TOKEN` es obligatorio si el bootstrap se habilita; sin valor configurado el endpoint responde 500 (nunca compara contra vacío).

### `AUTH_REGISTRATION_ENABLED` (default: deshabilitado — opt-in)

- Solo `true`/`1` habilita el registro público `POST /api/auth/register` (rol inicial `auditor`).
- Ausente/deshabilitado → 401 uniforme **antes** de consultar repositorios: no crea usuario, no asigna roles, no crea sesión, no emite JWT y no revela si un email existe.
- El login de usuarios existentes **no** se ve afectado por este flag.
- Rate limit dedicado: 10 requests / 15 min por IP.

### `JWT_EXPIRES_IN` (default: 28800)

- Duración del JWT en **segundos** (default 8 horas). Valor no numérico o ≤0 → fallback 8h.

### `TRUST_PROXY` (default: unset)

- Valor de Express `trust proxy`: `true`/`false`, número de saltos (p. ej. `1`) o expresión de proxy/CIDR.
- Déjalo unset salvo que el API esté detrás de reverse proxy. Sin configurar, `req.ip` —y por tanto las claves de los rate limiters— verá la IP del proxy y no la del cliente.

### `CORS_ORIGINS` (default: unset)

- Lista separada por comas de orígenes permitidos (p. ej. `https://app.example.com,https://admin.example.com`).
- **Unset = same-origin only**: no se emiten cabeceras CORS y el navegador bloquea los cross-origin.
- Nunca `*` en producción: la sesión viaja en cookie (`httpOnly`, `sameSite=lax`, `secure` en producción) y las credenciales exigen origen exacto.

## Rate limiting (in-memory)

| Endpoint | Límite | Ventana |
|---|---|---|
| `POST /api/auth/login` (local) | 5 | 15 min por IP |
| `POST /api/auth/login` (bootstrap) | 5 | 15 min por IP |
| `POST /api/auth/register` | 10 | 15 min por IP |

Almacenamiento en memoria de proceso: válido para una instancia. Despliegues multi-instancia requieren un store compartido (p. ej. Redis) — trabajo pendiente documentado (F17).

## Seguridad

- `helmet()` activo; cookie de sesión `httpOnly` + `sameSite=lax` + `secure` en producción.
- `requireAuth` exige JWT válido + `jti` + fila de sesión activa en allowlist; los cambios de rol revocan sesiones en la misma transacción; el login crea sesión transaccionalmente con lock de fila.
- Listados paginados server-side (`limit` default 50, máx 100, `offset` ≥ 0) aplicados en SQL.
