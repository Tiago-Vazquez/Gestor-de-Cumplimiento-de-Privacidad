import { timingSafeEqual, randomUUID } from "node:crypto";
import { Router, type IRouter } from "express";
import { rateLimit } from "express-rate-limit";
import { logger } from "../lib/logger";
import { repos } from "../repositories";
import { isProductionEnv, signToken, verifyToken } from "../auth/tokens";
import { requireAuth, type AuthedRequest } from "../auth/middleware";
import {
  extractSessionToken,
  sessionCookieName,
  sessionCookieOptions,
} from "../auth/cookies";
import { badRequest, conflict, unauthorized } from "../lib/errors";
import { sendProblemJson } from "../lib/problem-json";
import { hashPassword, verifyPassword } from "@workspace/auth";
import {
  isValidName,
  isValidPassword,
  normalizeEmail,
} from "../auth/validation";

const router: IRouter = Router();

// Identidad del usuario inicial que crea el login vía bootstrap. Determinístico
// para que el upsert sea idempotente en cada arranque.
const BOOTSTRAP_SUB = "bootstrap-admin";
const BOOTSTRAP_EMAIL = "admin@local";
const BOOTSTRAP_NAME = "Bootstrap Admin";

/**
 * Compara en tiempo constante el token recibido contra el configurado para
 * evitar ataques de timing. Si AUTH_BOOTSTRAP_TOKEN no está configurado se
 * considera un error de despliegue (500) y no se expone el valor esperado.
 */
function compareBootstrapToken(provided: string): boolean {
  const expected = process.env.AUTH_BOOTSTRAP_TOKEN;
  if (!expected) {
    throw new Error(
      "AUTH_BOOTSTRAP_TOKEN is not configured; login is disabled",
    );
  }
  const providedBuffer = Buffer.from(provided);
  const expectedBuffer = Buffer.from(expected);
  if (providedBuffer.length !== expectedBuffer.length) return false;
  return timingSafeEqual(providedBuffer, expectedBuffer);
}

/**
 * Kill switch del login bootstrap (legacy). Hardening 6.3B.15: el default es
 * DESHABILITADO (fail-closed). Solo se habilita de forma explícita con
 * `AUTH_BOOTSTRAP_ENABLED=true|1`; ausente, vacío o cualquier otro valor
 * (incluido "TRUE", "False", "yes" o typos) lo mantiene apagado. Conceder la
 * identidad admin de arranque exige una acción positiva de configuración,
 * nunca una omisión (mismo espíritu opt-in que AUTH_DISABLED, con polaridad
 * inversa al contrato pre-6.3B.15, que era fail-open por compatibilidad).
 */
export function bootstrapEnabled(): boolean {
  const raw = process.env.AUTH_BOOTSTRAP_ENABLED;
  return raw === "true" || raw === "1";
}

/**
 * Aviso de arranque (6.3B.15): el bootstrap de admin es opt-in y legacy.
 * Si un despliegue lo habilita explícitamente en producción, el entrypoint
 * registra una advertencia (no es una configuración prohibida —a diferencia
 * de AUTH_DISABLED— pero sí desaconsejada: identidad fija con rol admin y
 * token estático sujeto a filtración). Devuelve null cuando no procede.
 */
export function bootstrapProductionWarning(): string | null {
  if (isProductionEnv() && bootstrapEnabled()) {
    return (
      "AUTH_BOOTSTRAP_ENABLED is active in production: the fixed 'bootstrap-admin' " +
      "identity can regain the admin role on every login while it stays enabled. " +
      "Disable it (unset AUTH_BOOTSTRAP_ENABLED or set it to false) once local admins exist."
    );
  }
  return null;
}

/**
 * Kill switch del registro público (F2, 6.3B.20). Fail-closed con el mismo
 * contrato estricto que `bootstrapEnabled()`: SOLO "true"|"1" habilita;
 * ausente, vacío o cualquier otro valor (incluido "TRUE", "False", "yes" o
 * typos) lo mantiene deshabilitado. El registro es la vía por la que un
 * anónimo obtiene el rol `auditor` (acceso de lectura al dataset global),
 * así que el default es OFF y habilitarlo exige configuración explícita.
 */
export function registrationEnabled(): boolean {
  const raw = process.env.AUTH_REGISTRATION_ENABLED;
  return raw === "true" || raw === "1";
}

/**
 * Rate limit específico para login local (email+password): máximo 5 intentos
 * por IP cada 15 minutos. Protege contra ataques de fuerza bruta sobre
 * credenciales locales sin afectar al rate limiter general de la API.
 *
 * El login bootstrap ({token}) está EXENTO de este limiter: tiene su propio
 * `bootstrapLimiter` con bucket independiente (fase 6.3B.9, hallazgo B4), de
 * modo que agotar uno no afecta al otro y una misma IP no puede usar el flujo
 * bootstrap para eludir el límite del login local (ni viceversa).
 */
/**
 * Rate limit dedicado al registro público (F7, 6.3B.20): 10 intentos /
 * 15 min / IP, con bucket independiente del login/bootstrap. El registro es
 * una operación de escritura costosa (scrypt) alcanzable por anónimos, así
 * que merece su propio bucket: agotarlo no afecta al login (ni viceversa).
 * Los limiters globales de app.ts actúan como segunda capa.
 *
 * Hardening 6.3B.23 (F23-01): clave compuesta IP + email normalizado.
 * Misma lógica que loginLimiter — evasión por rotación de XFF y bucket
 * aislado por víctima.
 */
const registerLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: true,
  legacyHeaders: false,
  handler: (_req, res) => {
    sendProblemJson(res, {
      type: "about:blank",
      title: "Too Many Requests",
      status: 429,
      detail: "Too many registration attempts, please try again later.",
    });
  },
  keyGenerator: (req) => {
    const ip = req.ip ?? "unknown";
    const body = req.body ?? {};
    const email = typeof body.email === "string" ? normalizeEmail(body.email) : null;
    return email ? `${ip}:${email}` : ip;
  },
});

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 5,
  standardHeaders: true,
  legacyHeaders: false,
  handler: (_req, res) => {
    sendProblemJson(res, {
      type: "about:blank",
      title: "Too Many Requests",
      status: 429,
      detail: "Too many login attempts, please try again later.",
    });
  },
  // Hardening 6.3B.23 (F23-01): clave compuesta IP + email normalizado.
  // Impide evasión del límite mediante rotación de X-Forwarded-For y aísla
  // el bucket de cada víctima (el atacante no puede bloquear un email que no
  // conoce). Sin email válido (body mal formado) se recae a solo-IP.
  keyGenerator: (req) => {
    const ip = req.ip ?? "unknown";
    const body = req.body ?? {};
    const email = typeof body.email === "string" ? normalizeEmail(body.email) : null;
    return email ? `${ip}:${email}` : ip;
  },
  // Solo rate-limitear login local (email+password), no bootstrap token.
  skip: (req) => {
    const body = req.body ?? {};
    return typeof body.token === "string";
  },
});

/**
 * Rate limit dedicado al login bootstrap ({token}): máximo 5 intentos por IP
 * cada 15 minutos (fase 6.3B.9, recomendación B del diagnóstico 6.3B.8).
 *
 * Antes de este limiter el bootstrap quedaba exento del `loginLimiter` y solo
 * protegido por los limiters globales (≈30 req/min/IP), lo que permitía
 * ~43k intentos de fuerza bruta diarios contra `AUTH_BOOTSTRAP_TOKEN`.
 *
 * Bucket INDEPENDIENTE del login local: cada flujo consume únicamente su
 * propio limiter (los skips son mutuamente excluyentes) más los limiters
 * globales de `app.ts` como segunda capa de defensa.
 */
const bootstrapLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 5,
  standardHeaders: true,
  legacyHeaders: false,
  handler: (_req, res) => {
    sendProblemJson(res, {
      type: "about:blank",
      title: "Too Many Requests",
      status: 429,
      detail: "Too many bootstrap login attempts, please try again later.",
    });
  },
  // Solo rate-limitear el flujo bootstrap ({token}), no el login local.
  skip: (req) => {
    const body = req.body ?? {};
    return typeof body.token !== "string";
  },
});

/**
 * POST /api/auth/login
 *
 * Soporta dos flujos (mutuamente excluyentes):
 *
 * 1. Bootstrap (legacy, opt-in): { token: "..." }
 *    - Requiere AUTH_BOOTSTRAP_ENABLED=true|1 (6.3B.15: ausente = off).
 *    - Compara contra AUTH_BOOTSTRAP_TOKEN.
 *    - Usa identidad fija "bootstrap-admin" con rol admin.
 *    - TODO: Eliminar cuando se migre completamente a usuarios locales.
 *
 * 2. Local: { email: "...", password: "..." }
 *    - Busca usuario por email normalizado.
 *    - Verifica contraseña con scrypt.
 *    - Obtiene roles reales desde user_roles.
 *    - Actualiza last_login_at.
 *
 * Respuesta (ambos casos): { sub, email, roles }
 */
router.post("/login", loginLimiter, bootstrapLimiter, async (req, res) => {
  const body = req.body ?? {};

  // Flujo 1: Bootstrap token (legacy)
  if (typeof body.token === "string") {
    return handleBootstrapLogin(req, res, body.token);
  }

  // Flujo 2: Login local con email + password
  if (typeof body.email === "string" && typeof body.password === "string") {
    return handleLocalLogin(req, res, body.email, body.password);
  }

  throw badRequest("Request must contain either 'token' or 'email' + 'password'");
});


/**
 * Maneja el login vía bootstrap token (legacy).
 * TODO: Eliminar cuando se migre completamente a usuarios locales.
 */
async function handleBootstrapLogin(
  req: import("express").Request,
  res: import("express").Response,
  provided: string,
): Promise<void> {
  if (provided.length === 0) {
    throw badRequest("Missing bootstrap token in request body");
  }

  // Feature flag AUTH_BOOTSTRAP_ENABLED (opt-in: solo "true"|"1"; ausente =
  // deshabilitado, 6.3B.15). Si está deshabilitado, el bootstrap falla con la
  // MISMA respuesta que una credencial inválida (no filtra el estado del
  // mecanismo) y NO se emite JWT ni se crea sesión: el flujo se corta antes
  // de tocar repos/users, de firmar y de cualquier escritura en DB.
  if (!bootstrapEnabled()) {
    // Auditoría del intento (sin exponer el token ni estado interno).
    logger.info({ event: "bootstrap_login_rejected" }, "Bootstrap login disabled by flag");
    throw unauthorized("Invalid credentials");
  }

  if (!compareBootstrapToken(provided)) {
    throw unauthorized("Invalid credentials");
  }

  // Persistir/actualizar al usuario y asegurar rol admin (idempotente).
  const user = await repos.users.upsertBySub({
    sub: BOOTSTRAP_SUB,
    email: BOOTSTRAP_EMAIL,
    name: BOOTSTRAP_NAME,
  });
  await repos.userRoles.addRole(user.sub, "admin");

  // [6.3B.12] Login transaccional (mismo patron que el login local): lock de
  // la fila del usuario + lectura de roles reales + firma + alta de sesion en
  // UNA transaccion, para no emitir un JWT admin stale tras una demosion
  // concurrente (cierre del riesgo U3).
  const { jwt, roles } = await repos.sessions.createSessionForUser(
    user.sub,
    async (roles) =>
      signToken({
        sub: user.sub,
        email: user.email,
        name: user.name,
        roles,
      }),
  );

  res.cookie(sessionCookieName(), jwt, sessionCookieOptions());

  // Auditoría: se registra el login exitoso, NUNCA el token/JWT.
  logger.info({ sub: user.sub, event: "login", method: "bootstrap" }, "User logged in");

  res.status(200).json({
    sub: user.sub,
    email: user.email,
    roles,
  });
}

/**
 * Maneja el login local con email + password.
 * Obtiene roles reales desde user_roles (no hardcodear).
 */
async function handleLocalLogin(
  req: import("express").Request,
  res: import("express").Response,
  email: string,
  password: string,
): Promise<void> {
  const normalizedEmail = normalizeEmail(email);
  if (!normalizedEmail) {
    throw unauthorized("Invalid credentials");
  }

  const user = await repos.users.getByEmail(normalizedEmail);

  // Respuesta uniforme: no revela si el usuario existe o no
  if (!user || !user.passwordHash) {
    throw unauthorized("Invalid credentials");
  }

  const passwordValid = await verifyPassword(password, user.passwordHash);
  if (!passwordValid) {
    throw unauthorized("Invalid credentials");
  }

  // [6.3B.12] Login transaccional: lock de users(sub) FOR UPDATE + lectura
  // de roles + firma + alta de sesion en UNA tx (cierra U3: carrera login +
  // role-change que podia emitir un JWT con roles stale y sesion activa).
  const { jwt, roles } = await repos.sessions.createSessionForUser(
    user.sub,
    async (roles) =>
      signToken({
        sub: user.sub,
        email: user.email,
        name: user.name,
        roles,
      }),
  );

  res.cookie(sessionCookieName(), jwt, sessionCookieOptions());

  // Actualizar último login (solo en éxito) — deliberadamente FUERA de la
  // transacción de sesión: telemetría informativa, no afecta auth/authz y
  // un fallo aquí no debe revocar la sesión.
  await repos.users.updateLastLogin(user.sub);

  // Auditoría: se registra el login exitoso, NUNCA password/hash.
  logger.info({ sub: user.sub, event: "login", method: "local" }, "User logged in");

  res.status(200).json({
    sub: user.sub,
    email: user.email,
    roles,
  });
}

/**
 * POST /api/auth/register
 *
 * Registra un nuevo usuario con email + password.
 * Requiere AUTH_REGISTRATION_ENABLED=true|1 (F2, 6.3B.20: ausente = off,
 * fail-closed). Con el flag deshabilitado responde 401 uniforme sin tocar
 * repos ni revelar si un email existe.
 * El usuario recibe rol "auditor" por defecto (no admin).
 * No inicia sesión automáticamente (retorna 201 con datos públicos).
 */
router.post("/register", registerLimiter, async (req, res) => {
  // Kill switch ANTES de cualquier acceso a repos (getByEmail incluido):
  // cero escrituras, cero roles, cero sesiones, cero revelación de emails.
  if (!registrationEnabled()) {
    throw unauthorized("Registration is not available");
  }

  const body = req.body ?? {};
  const { email, password, name } = body;

  // Validar email
  const normalizedEmail = normalizeEmail(email);
  if (!normalizedEmail) {
    throw badRequest("A valid email is required");
  }

  // Validar contraseña (mínimo 12 caracteres)
  if (!isValidPassword(password)) {
    throw badRequest("Password must be at least 12 characters");
  }

  // Verificar que el email no exista
  const existing = await repos.users.getByEmail(normalizedEmail);
  if (existing) {
    throw conflict("Email already registered");
  }

  // Hash de la contraseña
  const passwordHash = await hashPassword(password);

  // Generar sub único y ESTABLE (UUID): independiente del email para que un
  // cambio de correo no altere la identidad del usuario ni sus referencias.
  const sub = randomUUID();

  // Crear usuario con rol inicial "auditor"
  const user = await repos.users.upsertBySub({
    sub,
    email: normalizedEmail,
    name: isValidName(name) ? name.trim() : null,
  });
  await repos.users.updatePasswordHash(sub, passwordHash);
  await repos.userRoles.addRole(sub, "auditor");

  // Auditoría: se registra el registro, NUNCA password/hash.
  logger.info({ sub, event: "register" }, "New user registered");

  res.status(201).json({
    sub: user.sub,
    email: user.email,
    name: user.name,
    roles: ["auditor"],
  });
});

/**
 * POST /api/auth/logout
 * No requiere autenticación estricta: permite cerrar sesión aunque el JWT haya
 * expirado. Invalida la cookie de sesión y, si el request porta un JWT
 * verificable con `jti`, revoca su fila de sesión (best-effort).
 *
 * Contrato: SIEMPRE 204 (idempotente). Un fallo de revocación no rompe la
 * respuesta: la expiración del JWT y la del allowlist (`expires_at`) invalidan
 * la sesión de todos modos. `revokeByJti` es no-op si la fila no existe o ya
 * está revocada.
 */
router.post("/logout", async (req, res) => {
  try {
    const token = extractSessionToken(req);
    if (token) {
      // Validación segura: solo se revoca si firma y claims son válidas
      // (un token manipulado/expirado no revoca nada).
      const payload = await verifyToken(token);
      if (payload?.jti) {
        await repos.sessions.revokeByJti(payload.jti);
      }
    }
  } catch {
    // Best-effort: el logout nunca debe fallar (204 garantizado).
  }
  res.clearCookie(sessionCookieName(), { path: "/" });
  res.status(204).end();
});

/**
 * GET /api/auth/me
 * Requiere autenticación. Devuelve la identidad del JWT (sin secretos).
 */
router.get("/me", requireAuth(), (req, res) => {
  const user = (req as AuthedRequest).user;
  res.status(200).json({
    sub: user?.sub ?? null,
    email: user?.email ?? null,
    roles: user?.roles ?? [],
  });
});

export default router;
