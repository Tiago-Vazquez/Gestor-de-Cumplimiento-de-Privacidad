import { timingSafeEqual, randomUUID } from "node:crypto";
import { Router, type IRouter } from "express";
import { rateLimit } from "express-rate-limit";
import { optionalPersistentStore } from "../lib/rate-limit-store";
import { logger } from "../lib/logger";
import { repos } from "../repositories";
import { BOOTSTRAP_ORGANIZATION_ID } from "../repositories/organizations.repo";
import { isProductionEnv, signToken, verifyToken } from "../auth/tokens";
import { requireAuth, type AuthedRequest } from "../auth/middleware";
import { requireCsrf } from "../auth/csrf";
import {
  extractSessionToken,
  sessionCookieName,
  sessionCookieOptions,
} from "../auth/cookies";
import { badRequest, conflict, notFound, unauthorized } from "../lib/errors";
import { sendProblemJson } from "../lib/problem-json";
import { generateCsrfToken } from "../auth/csrf";
import { sessionIdleSeconds } from "../lib/env";
import { recordAuditEvent } from "../lib/audit";
import { hashPassword, verifyPassword } from "@workspace/auth";
import {
  isValidName,
  isValidPassword,
  normalizeEmail,
  PASSWORD_MAX_LENGTH,
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
// M18 Fase 2 — store persistente (PostgreSQL) para los limiters sensibles.
// `AUTH_RATE_LIMIT_STORE=postgres` activa el contador en BD (supervive
// reinicios y es consistente multi-instancia); default `memory` preserva el
// comportamiento en tests/desarrollo. `undefined` ⇒ MemoryStore builtin.
// Cada limiter recibe su PROPIO store con namespace: al compartir una única
// tabla, dos limiters con la misma fórmula de clave (register y login usan
// `${ip}:${email}`) sumarían en el mismo contador y se sabotearían entre sí.
// El namespace replica el aislamiento que MemoryStore daba gratis.
const registerStore = optionalPersistentStore("register");
const loginStore = optionalPersistentStore("login");
const bootstrapStore = optionalPersistentStore("bootstrap");
const passwordChangeStore = optionalPersistentStore("password-change");

const registerLimiter = rateLimit({
  store: registerStore,
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
  store: loginStore,
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
  store: bootstrapStore,
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
    // M17 — intento fallido registrado con actor desconocido y sin el token.
    await recordAuditEvent({
      req,
      actorUserId: null,
      action: "login_failure",
      resourceType: "session",
      result: "failure",
      metadata: { method: "bootstrap", reason: "bootstrap_disabled" },
    });
    throw unauthorized("Invalid credentials");
  }

  if (!compareBootstrapToken(provided)) {
    // M17 — mismo registro para credencial inválida (respuesta uniforme).
    await recordAuditEvent({
      req,
      actorUserId: null,
      action: "login_failure",
      resourceType: "session",
      result: "failure",
      metadata: { method: "bootstrap", reason: "invalid_credentials" },
    });
    throw unauthorized("Invalid credentials");
  }

  // Persistir/actualizar al usuario y asegurar rol admin (idempotente).
  const user = await repos.users.upsertBySub({
    sub: BOOTSTRAP_SUB,
    email: BOOTSTRAP_EMAIL,
    name: BOOTSTRAP_NAME,
  });
  await repos.userRoles.addRole(user.sub, "admin");

  // M21.2 - bootstrap multi-tenancy: asegura la organizacion inicial y el
  // membership `owner` del administrador de arranque (ambos idempotentes) y
  // fija el contexto de organizacion de la sesion recien creada.
  await repos.organizations.ensureBootstrapOrganization();
  await repos.memberships.create({
    organizationId: BOOTSTRAP_ORGANIZATION_ID,
    userSub: user.sub,
    role: "owner",
  });
  const activeOrgId = await repos.memberships.getFirstOrgForUser(user.sub);

  // [6.3B.12] Login transaccional (mismo patron que el login local): lock de
  // la fila del usuario + lectura de roles reales + firma + alta de sesion en
  // UNA transaccion, para no emitir un JWT admin stale tras una demosion
  // concurrente (cierre del riesgo U3).
  // M11.1: el JWT emite el claim `csrf` (synchronizer token ligado a esta
  // sesión) generado una única vez por sesión; nunca se regenera por request.
  const { jwt, roles } = await repos.sessions.createSessionForUser(
    user.sub,
    async (roles) =>
      signToken({
        sub: user.sub,
        email: user.email,
        name: user.name,
        roles,
        csrf: generateCsrfToken(),
      }),
    activeOrgId,
  );

  res.cookie(sessionCookieName(), jwt, sessionCookieOptions());

  // Auditoría: se registra el login exitoso, NUNCA el token/JWT.
  logger.info({ sub: user.sub, event: "login", method: "bootstrap" }, "User logged in");

  // M17 — trazabilidad administrativa del login (método + actor, sin secretos).
  await recordAuditEvent({
    req,
    actorUserId: user.sub,
    action: "login_success",
    resourceType: "session",
    result: "success",
    metadata: { method: "bootstrap", roles },
  });

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
    // M17 — intento fallido: se registra el motivo, NUNCA el email/contraseña.
    await recordAuditEvent({
      req,
      actorUserId: null,
      action: "login_failure",
      resourceType: "session",
      result: "failure",
      metadata: { method: "local", reason: "invalid_email" },
    });
    throw unauthorized("Invalid credentials");
  }

  // Fase 6 (M18): rechazo temprano de credenciales de tamaño imposible, antes
  // de tocar la BD y sobre todo antes de scrypt (verificación costosa: con
  // entradas desmedidas cada intento amplifica CPU/RAM). Respuesta uniforme.
  if (typeof password !== "string" || password.length > PASSWORD_MAX_LENGTH) {
    await recordAuditEvent({
      req,
      actorUserId: null,
      action: "login_failure",
      resourceType: "session",
      result: "failure",
      metadata: { method: "local", reason: "password_too_long" },
    });
    throw unauthorized("Invalid credentials");
  }

  const user = await repos.users.getByEmail(normalizedEmail);

  // Respuesta uniforme: no revela si el usuario existe o no
  if (!user || !user.passwordHash) {
    await recordAuditEvent({
      req,
      actorUserId: null,
      action: "login_failure",
      resourceType: "session",
      result: "failure",
      metadata: { method: "local", reason: "unknown_account" },
    });
    throw unauthorized("Invalid credentials");
  }

  const passwordValid = await verifyPassword(password, user.passwordHash);
  if (!passwordValid) {
    await recordAuditEvent({
      req,
      actorUserId: null,
      action: "login_failure",
      resourceType: "session",
      result: "failure",
      metadata: { method: "local", reason: "invalid_password" },
    });
    throw unauthorized("Invalid credentials");
  }

  // M21.2 - el contexto de organizacion inicial de la sesion es la primera
  // membership del usuario (orden de ingreso); null si no tiene ninguna.
  const activeOrgId = await repos.memberships.getFirstOrgForUser(user.sub);
  // [6.3B.12] Login transaccional: lock de users(sub) FOR UPDATE + lectura
  // de roles + firma + alta de sesion en UNA tx (cierra U3: carrera login +
  // role-change que podia emitir un JWT con roles stale y sesion activa).
  // M11.1: el JWT emite el claim `csrf` (synchronizer token ligado a esta
  // sesión) generado una única vez por sesión; nunca se regenera por request.
  const { jwt, roles } = await repos.sessions.createSessionForUser(
    user.sub,
    async (roles) =>
      signToken({
        sub: user.sub,
        email: user.email,
        name: user.name,
        roles,
        csrf: generateCsrfToken(),
      }),
    activeOrgId,
  );

  res.cookie(sessionCookieName(), jwt, sessionCookieOptions());

  // Actualizar último login (solo en éxito) — deliberadamente FUERA de la
  // transacción de sesión: telemetría informativa, no afecta auth/authz y
  // un fallo aquí no debe revocar la sesión.
  await repos.users.updateLastLogin(user.sub);

  // Auditoría: se registra el login exitoso, NUNCA password/hash.
  logger.info({ sub: user.sub, event: "login", method: "local" }, "User logged in");

  // M17 — trazabilidad administrativa del login (método + actor, sin secretos).
  await recordAuditEvent({
    req,
    actorUserId: user.sub,
    action: "login_success",
    resourceType: "session",
    result: "success",
    metadata: { method: "local", roles },
  });

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

  // Fase 6 (M18): tope superior explícito. El body ya está acotado a 16kb, pero
  // un password desmedido se pasaría íntegro a scrypt (coste amplificable).
  if (typeof password === "string" && password.length > PASSWORD_MAX_LENGTH) {
    throw badRequest(`Password must be at most ${PASSWORD_MAX_LENGTH} characters`);
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
 * Rate limit dedicado al cambio de contraseña (M11.2.1): 5 intentos / 15 min,
 * clave compuesta IP + sub autenticado. Es una operación sensible (verifica la
 * contraseña actual y revoca sesiones) y costosa (scrypt): bucket propio para
 * que agotarlo no afecte al login ni al registro, y viceversa. Los limiters
 * globales de app.ts actúan como segunda capa.
 */
const passwordChangeLimiter = rateLimit({
  store: passwordChangeStore,
  windowMs: 15 * 60 * 1000,
  limit: 5,
  standardHeaders: true,
  legacyHeaders: false,
  handler: (_req, res) => {
    sendProblemJson(res, {
      type: "about:blank",
      title: "Too Many Requests",
      status: 429,
      detail: "Too many password change attempts, please try again later.",
    });
  },
  keyGenerator: (req) => {
    const ip = req.ip ?? "unknown";
    const sub = (req as AuthedRequest).user?.sub ?? "anonymous";
    return `${ip}:${sub}`;
  },
});

/**
 * POST /api/auth/password/change (M11.2.1)
 *
 * Cambio de contraseña autenticado. Requiere sesión activa (requireAuth) y,
 * cuando la sesión viaja por cookie, el header `X-CSRF-Token` (requireCsrf de
 * M11.1 — el router /auth se monta antes del guard global, así que el middleware
 * se aplica a nivel de ruta; misma implementación, cero modificaciones).
 *
 * Flujo:
 *  1. verifica la contraseña actual contra el hash almacenado (scrypt);
 *  2. valida la nueva contraseña con la MISMA política del registro
 *     (isValidPassword: mínimo 12 caracteres);
 *  3. hashea y actualiza en la misma transacción que revoca todas las demás
 *     sesiones activas del usuario; la sesión actual (exceptJti) permanece.
 *
 * Nunca registra ni devuelve: contraseñas, hash, JWT ni tokens CSRF.
 */
router.post(
  "/password/change",
  requireAuth(),
  passwordChangeLimiter,
  requireCsrf(),
  async (req, res) => {
    const authed = (req as AuthedRequest).user;
    if (!authed?.sub) throw unauthorized("Missing or invalid session");

    const body = req.body ?? {};
    const { currentPassword, newPassword } = body;
    if (typeof currentPassword !== "string" || currentPassword.length === 0) {
      throw badRequest("currentPassword is required");
    }
    if (typeof newPassword !== "string" || newPassword.length === 0) {
      throw badRequest("newPassword is required");
    }
    // Fase 6 (M18): topes superiores antes de scrypt. `verifyPassword` y
    // `hashPassword` son costosos, así que un valor desmedido multiplica
    // CPU/RAM por request. La actual responde 401 uniforme (no revela que el
    // rechazo fue por tamaño); la nueva, 400 con el tope explícito.
    if (currentPassword.length > PASSWORD_MAX_LENGTH) {
      throw unauthorized("Invalid credentials");
    }
    if (newPassword.length > PASSWORD_MAX_LENGTH) {
      throw badRequest(
        `Password must be at most ${PASSWORD_MAX_LENGTH} characters`,
      );
    }

    const account = await repos.users.getBySub(authed.sub);
    if (!account) {
      throw unauthorized("Missing or invalid session");
    }
    if (!account.passwordHash) {
      // Cuentas sin contraseña local (bootstrap-admin, futuros OIDC): no hay
      // hash contra el que verificar la contraseña actual.
      throw badRequest("Password change is not available for this account");
    }

    // Verificación de la contraseña actual (scrypt, tiempo constante interno).
    const currentValid = await verifyPassword(
      currentPassword,
      account.passwordHash,
    );
    if (!currentValid) {
      throw unauthorized("Invalid credentials");
    }

    // MISMA política que el registro — no se inventa una nueva.
    if (!isValidPassword(newPassword)) {
      throw badRequest("Password must be at least 12 characters");
    }

    // La nueva contraseña debe diferir de la actual (evita "rotaciones" no-op).
    if (newPassword === currentPassword) {
      throw badRequest("New password must differ from the current password");
    }

    const passwordHash = await hashPassword(newPassword);

    // Transacción única: hash nuevo + revocación del resto de sesiones.
    const revokedSessions =
      await repos.users.changePasswordAndRevokeOtherSessions(
        authed.sub,
        passwordHash,
        authed.jti ?? null,
      );

    // M17 — trazabilidad del cambio de contraseña: solo el conteo de sesiones
    // revocadas (nunca contraseñas, hash, JWT ni tokens CSRF).
    await recordAuditEvent({
      req,
      actorUserId: authed.sub,
      action: "password_changed",
      resourceType: "user",
      resourceId: authed.sub,
      result: "success",
      metadata: { revokedSessions },
    });

    // Auditoría mínima: evento sin secretos (nunca password/hash/JWT/CSRF).
    logger.info(
      { event: "password-change", sub: authed.sub, revokedSessions },
      "Password changed; other sessions revoked",
    );

    res.status(200).json({ ok: true, revokedSessions });
  },
);

/**
 * Rate limit dedicado a la gestión de sesiones (M11.2.2): 30 peticiones /
 * 15 min, clave compuesta IP + sub autenticado. Cubre GET /sessions,
 * DELETE /sessions/:jti y POST /logout-all: operaciones autenticadas de baja
 * frecuencia; bucket propio para que un abuso no agote el bucket global ni el
 * de login. Los limiters globales de app.ts actúan como segunda capa.
 */
const sessionManagementLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 30,
  standardHeaders: true,
  legacyHeaders: false,
  handler: (_req, res) => {
    sendProblemJson(res, {
      type: "about:blank",
      title: "Too Many Requests",
      status: 429,
      detail: "Too many session management requests, please try again later.",
    });
  },
  keyGenerator: (req) => {
    const ip = req.ip ?? "unknown";
    const sub = (req as AuthedRequest).user?.sub ?? "anonymous";
    return `${ip}:${sub}`;
  },
});

/**
 * GET /api/auth/sessions (M11.2.2)
 *
 * Lista las sesiones activas del usuario autenticado. Solo metadatos de la
 * fila (jti, fechas); NUNCA el claim csrf (vive en el JWT), tokens ni hashes.
 * `current: true` marca la sesión que realiza la petición (por jti).
 */
router.get("/sessions", requireAuth(), sessionManagementLimiter, async (req, res) => {
  const authed = (req as AuthedRequest).user;
  if (!authed?.sub) throw unauthorized("Missing or invalid session");

  const rows = await repos.sessions.listActiveByUser(authed.sub);
  res.status(200).json({
    sessions: rows.map((s) => ({
      jti: s.jti,
      createdAt: s.issuedAt.toISOString(),
      expiresAt: s.expiresAt.toISOString(),
      current: s.jti === authed.jti,
    })),
  });
});

/**
 * DELETE /api/auth/sessions/:jti (M11.2.2)
 *
 * Revoca UNA sesión propia. Aislamiento: si el jti no existe o pertenece a
 * OTRO usuario, responde 404 idéntico (nunca 403) para no permitir enumerar
 * sesiones ajenas. Idempotente: una sesión ya revocada responde 200.
 * Revocar la sesión actual está permitido: la siguiente petición con esa
 * sesión recibirá 401 (invalidación por jti en requireAuth).
 *
 * CSRF: cookie sin X-CSRF-Token → 403 (requireCsrf, M11.1). Bearer puro no
 * usa cookies, así que no hay CSRF posible y queda exento por diseño.
 */
router.delete(
  "/sessions/:jti",
  requireAuth(),
  sessionManagementLimiter,
  requireCsrf(),
  async (req, res) => {
    const authed = (req as AuthedRequest).user;
    if (!authed?.sub) throw unauthorized("Missing or invalid session");

    const rawJti = req.params.jti;
    const jti = Array.isArray(rawJti) ? rawJti[0] : rawJti;
    const session = jti
      ? await repos.sessions.findActiveByJti(jti, sessionIdleSeconds())
      : null;
    // 404 uniforme para: inexistente, ajena o ya revocada (no filtramos cuál).
    if (!session || session.userSub !== authed.sub) {
      throw notFound("Session not found");
    }

    await repos.sessions.revokeByJti(jti as string);

    // M17 — revocación individual: el recurso es la sesión (jti) revocada.
    await recordAuditEvent({
      req,
      actorUserId: authed.sub,
      action: "session_revoked",
      resourceType: "session",
      resourceId: jti as string,
      result: "success",
    });

    res.status(200).json({ revoked: true });
  },
);

/**
 * POST /api/auth/logout-all (M11.2.2)
 *
 * Revoca TODAS las sesiones activas del usuario, INCLUIDA la actual.
 * Respuesta 200 { revoked } emitida con la sesión ya muerta: la siguiente
 * petición con la sesión actual recibirá 401. No limpia la cookie aquí —
 * el cliente debe tratarlo como un logout y redirigir a login (mismo
 * comportamiento que /logout, que sí limpia; el JWT revocado no sirve de
 * todos modos gracias al allowlist).
 *
 * No afecta sesiones de otros usuarios (filtra por userSub).
 */
router.post(
  "/logout-all",
  requireAuth(),
  sessionManagementLimiter,
  requireCsrf(),
  async (req, res) => {
    const authed = (req as AuthedRequest).user;
    if (!authed?.sub) throw unauthorized("Missing or invalid session");

    const revoked = await repos.sessions.revokeAllForUser(authed.sub);

    // M17 — trazabilidad administrativa (contador de sesiones revocadas).
    await recordAuditEvent({
      req,
      actorUserId: authed.sub,
      action: "logout_all",
      resourceType: "session",
      result: "success",
      metadata: { revoked },
    });

    logger.info(
      { event: "logout-all", sub: authed.sub, revoked },
      "All sessions revoked by user",
    );
    res.status(200).json({ revoked });
  },
);

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
        // M17 — logout de una sesión identificable: actor tomado del JWT ya
        // verificado (este endpoint es público a propósito). Sin tokens.
        await recordAuditEvent({
          req,
          actorUserId: payload.sub ?? null,
          action: "logout",
          resourceType: "session",
          resourceId: payload.jti,
          result: "success",
        });
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
