import { randomUUID } from "node:crypto";
import { Router, type IRouter } from "express";
import { z } from "zod";
import { rateLimit, type Store } from "express-rate-limit";
import { decodeJwt } from "jose";
import { optionalPersistentStore } from "../lib/rate-limit-store";
import { logger } from "../lib/logger";
import { repos } from "../repositories";
import { signToken, verifyToken } from "../auth/tokens";
import { requireAuth, requireMfaVerified, type AuthedRequest } from "../auth/middleware";
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
import { deliverResetLink } from "../auth/password-reset-delivery";
import * as passwordReset from "../repositories/password-reset.repo";
import { encrypt, decrypt } from "../lib/secret-manager";
import { generateTotpSecret, verifyTotp, buildOtpauthUrl } from "../lib/totp";
import { hashPassword, verifyPassword } from "@workspace/auth";
import {
  isValidName,
  isValidPassword,
  normalizeEmail,
  PASSWORD_MAX_LENGTH,
} from "../auth/validation";

const router: IRouter = Router();

/**
 * Kill switch del registro público (F2, 6.3B.20). Fail-closed con el mismo
 * contrato estricto (solo "true"|"1"): habilita;
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

// M30.0 (recuperacion de contrasena): store por IP pura.
// Se separan de login a proposito: el bucket de login se key por IP+email,
// y el reset se pide SIN sesion, asi que solo hay IP.
// Store PROPIO: compartir bucket con otro limiter los sabotearia entre si.
const forgotStore = optionalPersistentStore("password-reset-forgot");
const resetStore = optionalPersistentStore("password-reset-consume");

/**
 * M30.0: clave compuesta IP + email normalizado, misma logica que
 * loginLimiter. Sin ella, un atacante podria agotar el bucket de una victima
 * desde la misma IP y dejar a esa persona sin poder pedir su enlace.
 */
const forgotKeyGenerator = (req: { ip?: string; body?: unknown }) => {
  const ip = req.ip ?? "";
  const body = req.body as { email?: unknown } | undefined;
  const email = typeof body?.email === "string" ? normalizeEmail(body.email) : null;
  return email ? `${ip}:${email}` : ip;
};

const forgotLimiter = rateLimit({
  store: forgotStore,
  windowMs: 15 * 60 * 1000,
  // 5 es alto a proposito: la respuesta es uniforme, asi que el limite
  // protege el scrypt del reset, no oculta informacion.
  limit: 5,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: forgotKeyGenerator as never,
});

const resetLimiter = rateLimit({
  store: resetStore,
  windowMs: 15 * 60 * 1000,
  // scrypt es caro por intento: 10 es el techo de fuerza bruta tolerable.
  limit: 10,
  standardHeaders: true,
  legacyHeaders: false,
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
});

// --- MFA (Fase 2): constantes y rate limiters ---
const MFA_ISSUER = "Privaris";
const MFA_PENDING_TTL_SECONDS = 300; // sesión pre-MFA: 5 minutos
const MFA_SETUP_TTL_MS = 10 * 60 * 1000; // secreto pendiente: 10 minutos

function mfaLimiter(store: Store | undefined, limit: number, detail: string) {
  return rateLimit({
    store,
    windowMs: 15 * 60 * 1000,
    limit,
    standardHeaders: true,
    legacyHeaders: false,
    handler: (_req, res) => {
      sendProblemJson(res, {
        type: "about:blank",
        title: "Too Many Requests",
        status: 429,
        detail,
      });
    },
    // Clave IP + sub: no se permite evadir el límite cambiando parámetros del
    // body (la identidad proviene de la sesión verificada, no del cliente).
    keyGenerator: (req) => {
      const ip = req.ip ?? "unknown";
      const sub = (req as AuthedRequest).user?.sub ?? "anonymous";
      return `${ip}:${sub}`;
    },
  });
}

const mfaVerifyLimiter = mfaLimiter(
  optionalPersistentStore("mfa-verify"),
  5,
  "Too many MFA verification attempts, please try again later.",
);
const mfaRecoveryLimiter = mfaLimiter(
  optionalPersistentStore("mfa-recovery"),
  5,
  "Too many MFA recovery attempts, please try again later.",
);
const mfaSetupLimiter = mfaLimiter(
  optionalPersistentStore("mfa-setup"),
  10,
  "Too many MFA setup attempts, please try again later.",
);
const mfaDisableLimiter = mfaLimiter(
  optionalPersistentStore("mfa-disable"),
  5,
  "Too many MFA disable attempts, please try again later.",
);
const mfaRegenerateLimiter = mfaLimiter(
  optionalPersistentStore("mfa-regenerate"),
  5,
  "Too many MFA recovery code regeneration attempts, please try again later.",
);

/**
 * POST /api/auth/login
 *
 * Login local con email + password:
 *   - Busca usuario por email normalizado.
 *   - Verifica contraseña con scrypt.
 *   - Obtiene roles reales desde user_roles.
 *   - Actualiza last_login_at.
 *
 * Respuesta: { sub, email, roles }
 */
router.post("/login", loginLimiter, async (req, res) => {
  const body = req.body ?? {};

  if (typeof body.email === "string" && typeof body.password === "string") {
    return handleLocalLogin(req, res, body.email, body.password);
  }

  throw badRequest("Request must contain 'email' + 'password'");
});


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

  // --- Fase 2 MFA: contraseña correcta + MFA habilitado → sesión pre-MFA ---
  // Misma respuesta uniforme que la rama sin MFA (sin enumeración). NO se
  // crean roles ni sesión completa todavía: el frontend debe pedir el TOTP.
  const mfaState = await repos.mfa.getMfaState(user.sub);
  if (mfaState?.mfaEnabled) {
    const { jwt } = await repos.sessions.createSessionForUser(
      user.sub,
      async (roles) =>
        signToken(
          {
            sub: user.sub,
            email: user.email,
            name: user.name,
            roles,
            csrf: generateCsrfToken(),
          },
          { expiresInSeconds: MFA_PENDING_TTL_SECONDS },
        ),
      activeOrgId,
    );
    const pendingDecoded = decodeJwt(jwt);
    if (typeof pendingDecoded.jti !== "string") {
      // Nunca debería ocurrir; sin cookie emitida → 401 uniforme.
      throw unauthorized("Invalid credentials");
    }
    await repos.mfa.setSessionMfaPending(pendingDecoded.jti, true);
    res.cookie(sessionCookieName(), jwt, sessionCookieOptions());

    // Auditoría: password correcta + desafío MFA pendiente (sin secretos).
    await recordAuditEvent({
      req,
      actorUserId: user.sub,
      action: "login_success",
      resourceType: "session",
      result: "success",
      metadata: { method: "local", mfaRequired: true },
    });
    logger.info(
      { sub: user.sub, event: "login", method: "local", mfaRequired: true },
      "MFA challenge issued",
    );

    // Respuesta mínima: SIN roles, SIN secretos.
    res.status(200).json({ mfaRequired: true, sub: user.sub, email: user.email });
    return;
  }
  // --- fin Fase 2 MFA ---

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
  requireMfaVerified(),
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
      // Cuentas sin contraseña local (ej. usuarios OIDC futuros): no hay
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
router.get("/sessions", requireAuth(), requireMfaVerified(), sessionManagementLimiter, async (req, res) => {
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
  requireMfaVerified(),
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
  const authed = req as AuthedRequest;
  res.status(200).json({
    sub: user?.sub ?? null,
    email: user?.email ?? null,
    roles: user?.roles ?? [],
    // Fase 2 MFA: permite al frontend detectar el estado pre-MFA al recargar.
    mfaPending: authed.mfaPending === true,
  });
});


// =============================================================================
// M30.0 — Recuperación de contraseña.
//
// Sin sesión: por definición el usuario no recuerda su contraseña. Ninguna de
// las dos rutas usa `requireAuth()`. La de reset tampoco usa `requireCsrf()`,
// igual que `/login`: no hay sesión que proteger y el token ES la credencial.
// =============================================================================

/**
 * Base del enlace. Deriva del origen de la petición porque, sinReverse proxy
 * confiança, un host cabecero falsificado construiría un enlace que nadie
 * recibe. El token es la credencial; el host solo decide dónde se llega.
 */
function resetLinkBase(req: { protocol: string; get(name: string): string | undefined }): string {
  const configured = process.env.PASSWORD_RESET_BASE_URL;
  if (configured && configured.trim() !== "") return configured.trim().replace(/\/+$/, "");
  const host = req.get("host") ?? "localhost:8080";
  return `${req.protocol}://${host}`;
}

const ForgotBody = z.object({
  email: z.string().min(3).max(320),
});

/**
 * `POST /api/auth/password/forgot` — pide un enlace de recuperación.
 *
 * Respuesta SIEMPRE 202 con el mismo cuerpo, exista o no la cuenta: responder
 * distinto revelaría qué emails están registrados (enumeración de cuentas).
 * El trabajo real ocurre igualmente; solo el resultado se oculta.
 *
 * El fallo del canal de entrega NUNCA cambia el código de respuesta: el
 * contrato con el cliente es "si el email existe, recibirás un enlace".
 */
router.post("/password/forgot", forgotLimiter, async (req, res) => {
  const parsed = ForgotBody.safeParse(req.body ?? {});
  if (!parsed.success) throw badRequest("A valid email is required");

  const email = normalizeEmail(parsed.data.email);
  const account = email ? await repos.users.getByEmail(email) : null;

  // Existe: se emite el token y se entrega el enlace por el seam.
  if (account && account.passwordHash) {
    const token = passwordReset.generatePasswordResetToken();
    const expiresAt = new Date(Date.now() + passwordReset.PASSWORD_RESET_TTL_MS);
    await repos.passwordReset.create({
      userSub: account.sub,
      tokenHash: passwordReset.hashPasswordResetToken(token),
      expiresAt,
      requestedIp: req.ip ?? null,
    });
    await deliverResetLink({
      email: account.email,
      resetUrl: `${resetLinkBase(req)}/reset-password?token=${encodeURIComponent(token)}`,
      expiresAt,
    });
    await recordAuditEvent({
      req,
      actorUserId: account.sub,
      action: "password_reset_requested",
      resourceType: "session",
      result: "success",
      metadata: { method: "local" },
    });
  }

  // No existe: no se crea nada, pero la respuesta es indistinguible.
  res.status(202).json({
    status: "accepted",
    message: "If the account exists, a reset link has been sent.",
  });
});

const ResetBody = z.object({
  token: z.string().min(16).max(256),
  newPassword: z.string().min(1).max(PASSWORD_MAX_LENGTH),
});

/**
 * `POST /api/auth/password/reset` — consume el enlace y fija la contraseña.
 *
 * Todos los fallos (inexistente, expirado, ya usado) responden el MISMO 400
 * con el mismo texto: distinguir "expirado" de "inexistente" convertiría el
 * endpoint en un oráculo sobre tokens ya filtrados.
 */
router.post("/password/reset", resetLimiter, async (req, res) => {
  const parsed = ResetBody.safeParse(req.body ?? {});
  if (!parsed.success) throw badRequest("Invalid or expired reset token");

  const { token, newPassword } = parsed.data;

  if (!isValidPassword(newPassword)) {
    throw badRequest("Password must be at least 12 characters");
  }

  const passwordHash = await hashPassword(newPassword);
  const result = await repos.passwordReset.consumeByTokenHash({
    tokenHash: passwordReset.hashPasswordResetToken(token),
    newPasswordHash: passwordHash,
    now: new Date(),
  });

  if (!result.ok) {
    throw badRequest("Invalid or expired reset token");
  }

  // Trazabilidad. El token NO se registra jamás.
  await recordAuditEvent({
    req,
    actorUserId: result.userSub,
    action: "password_reset_completed",
    resourceType: "session",
    result: "success",
    metadata: { method: "local", allSessionsRevoked: true },
  });

  res.status(200).json({
    status: "ok",
    message: "Password updated. All sessions have been revoked.",
  });
});

// =============================================================================
// MFA (Fase 2) — endpoints /auth/mfa/*
//
// Excepciones pre-MFA: /auth/mfa/verify y /auth/mfa/recovery se permiten con
// sesión mfa_pending (requireAuth). El resto exigen sesión completa
// (requireMfaVerified). Ningún endpoint devuelve ni registra el secreto TOTP,
// el otpauth:// ni los recovery codes: los plaintext viajan SOLO en la
// respuesta de enable / regenerate (una vez).
// =============================================================================

/** Body de código TOTP de 6 dígitos. */
const TotpCodeBody = z.object({
  code: z.string().regex(/^\d{6}$/, "code must be a 6-digit TOTP code"),
});

/** Body de recovery code (10 chars base32, agrupados o no). */
const RecoveryCodeBody = z.object({
  code: z.string().min(4).max(64),
});

/**
 * GET /api/auth/mfa/status — estado MFA para la UI. Sesión completa.
 * Nunca devuelve secreto, otpauth, recovery codes ni hashes.
 */
router.get("/mfa/status", requireAuth(), requireMfaVerified(), async (req, res) => {
  const user = (req as AuthedRequest).user;
  if (!user?.sub) throw unauthorized("Missing or invalid session");
  const state = await repos.mfa.getMfaState(user.sub);
  const enabled = state?.mfaEnabled ?? false;
  const pendingEnrollment = !enabled && state?.mfaSecretEncrypted != null;
  res.status(200).json({ enabled, pendingEnrollment });
});

/**
 * POST /api/auth/mfa/setup — genera un secreto PENDIENTE y devuelve el
 * otpauth:// para el QR. Sesión completa + MFA deshabilitado + CSRF + limit.
 * El otpauth:// contiene el secreto por diseño: viaja SOLO en la respuesta
 * HTTPS, jamás en logs ni auditoría.
 */
router.post(
  "/mfa/setup",
  requireAuth(),
  requireMfaVerified(),
  mfaSetupLimiter,
  requireCsrf(),
  async (req, res) => {
    const user = (req as AuthedRequest).user;
    if (!user?.sub) throw unauthorized("Missing or invalid session");

    const state = await repos.mfa.getMfaState(user.sub);
    if (state?.mfaEnabled) throw conflict("MFA is already enabled");

    const secret = generateTotpSecret();
    const now = new Date();
    const ok = await repos.mfa.beginMfaSetup(user.sub, encrypt(secret), now);
    if (!ok) throw conflict("MFA is already enabled");

    const otpauthUrl = buildOtpauthUrl({
      issuer: MFA_ISSUER,
      account: user.email ?? user.sub,
      secretBase32: secret,
    });

    await recordAuditEvent({
      req,
      actorUserId: user.sub,
      action: "mfa_setup_started",
      resourceType: "user",
      resourceId: user.sub,
      result: "success",
      metadata: { method: "totp" },
    });

    // El otpauth:// (con secreto) solo viaja aquí; NUNCA se registra.
    res.status(200).json({ otpauthUrl });
  },
);

/**
 * POST /api/auth/mfa/enable — confirma el primer TOTP, activa MFA y genera
 * exactamente 10 recovery codes. Los plaintext viajan SOLO en esta respuesta.
 */
router.post(
  "/mfa/enable",
  requireAuth(),
  requireMfaVerified(),
  mfaSetupLimiter,
  requireCsrf(),
  async (req, res) => {
    const user = (req as AuthedRequest).user;
    if (!user?.sub) throw unauthorized("Missing or invalid session");

    const parsed = TotpCodeBody.safeParse(req.body ?? {});
    if (!parsed.success) throw badRequest("code must be a 6-digit TOTP code");

    const state = await repos.mfa.getMfaState(user.sub);
    if (state?.mfaEnabled) throw conflict("MFA is already enabled");
    if (!state?.mfaSecretEncrypted || !state.mfaSecretSetAt) {
      throw badRequest("MFA setup has not been started");
    }
    if (Date.now() - state.mfaSecretSetAt.getTime() > MFA_SETUP_TTL_MS) {
      throw badRequest("MFA setup has expired; start again");
    }

    const now = new Date();
    let step: number | null = null;
    try {
      step = verifyTotp(decrypt(state.mfaSecretEncrypted), parsed.data.code, now.getTime());
    } catch {
      step = null;
    }
    if (step === null) {
      await recordAuditEvent({
        req,
        actorUserId: user.sub,
        action: "mfa_verification_failure",
        resourceType: "user",
        resourceId: user.sub,
        result: "failure",
        metadata: { method: "totp", context: "enable" },
      });
      throw badRequest("Invalid or expired TOTP code");
    }

    await repos.mfa.enableMfa(user.sub, now);
    const recoveryCodes = await repos.mfa.regenerateRecoveryCodes(user.sub);

    await recordAuditEvent({
      req,
      actorUserId: user.sub,
      action: "mfa_enabled",
      resourceType: "user",
      resourceId: user.sub,
      result: "success",
      metadata: { method: "totp", recoveryCodes: recoveryCodes.length },
    });

    // Códigos plaintext SOLO en esta respuesta (una vez). Nunca en logs.
    res.status(200).json({ enabled: true, recoveryCodes });
  },
);

/**
 * POST /api/auth/mfa/verify — confirma el TOTP durante el login y promueve la
 * sesión pre-MFA → completa en UNA transacción (anti-replay atómico: dos
 * verificaciones concurrentes del mismo step → solo una gana).
 * Acepta SOLO sesión mfa_pending.
 */
router.post(
  "/mfa/verify",
  requireAuth(),
  mfaVerifyLimiter,
  requireCsrf(),
  async (req, res) => {
    const authed = req as AuthedRequest;
    const user = authed.user;
    if (!user?.sub || !user.jti) throw unauthorized("Missing or invalid session");
    if (authed.mfaPending !== true) {
      throw badRequest("Session is not awaiting MFA verification");
    }

    const parsed = TotpCodeBody.safeParse(req.body ?? {});
    if (!parsed.success) throw badRequest("code must be a 6-digit TOTP code");

    const state = await repos.mfa.getMfaState(user.sub);
    if (!state?.mfaEnabled || !state.mfaSecretEncrypted) {
      throw unauthorized("Invalid credentials");
    }

    const now = new Date();
    let step: number | null = null;
    try {
      step = verifyTotp(decrypt(state.mfaSecretEncrypted), parsed.data.code, now.getTime());
    } catch {
      step = null;
    }
    if (step === null) {
      await recordAuditEvent({
        req,
        actorUserId: user.sub,
        action: "mfa_verification_failure",
        resourceType: "session",
        resourceId: user.jti,
        result: "failure",
        metadata: { method: "totp", context: "login" },
      });
      throw unauthorized("Invalid or expired TOTP code");
    }

    const activeOrgId = await repos.memberships.getFirstOrgForUser(user.sub);
    const result = await repos.mfa.promotePendingSession({
      userSub: user.sub,
      pendingJti: user.jti,
      buildToken: (roles) =>
        signToken({
          sub: user.sub,
          email: user.email,
          name: user.name,
          roles,
          csrf: generateCsrfToken(),
        }),
      activeOrgId,
      now,
      advanceStep: step,
    });

    if (!result.ok) {
      await recordAuditEvent({
        req,
        actorUserId: user.sub,
        action: "mfa_verification_failure",
        resourceType: "session",
        resourceId: user.jti,
        result: "failure",
        metadata: { method: "totp", context: "login", reason: "replay" },
      });
      throw unauthorized("Invalid or expired TOTP code");
    }

    res.cookie(sessionCookieName(), result.jwt, sessionCookieOptions());
    await repos.users.updateLastLogin(user.sub);

    await recordAuditEvent({
      req,
      actorUserId: user.sub,
      action: "mfa_verification_success",
      resourceType: "session",
      resourceId: user.jti,
      result: "success",
      metadata: { method: "totp" },
    });

    res.status(200).json({ sub: user.sub, email: user.email, roles: result.roles });
  },
);

/**
 * POST /api/auth/mfa/recovery — recupera el acceso con un recovery code
 * durante el login (single-use). Acepta SOLO sesión mfa_pending.
 * Consume el código atómicamente y promueve la sesión (revoca pendiente).
 */
router.post(
  "/mfa/recovery",
  requireAuth(),
  mfaRecoveryLimiter,
  requireCsrf(),
  async (req, res) => {
    const authed = req as AuthedRequest;
    const user = authed.user;
    if (!user?.sub || !user.jti) throw unauthorized("Missing or invalid session");
    if (authed.mfaPending !== true) {
      throw badRequest("Session is not awaiting MFA verification");
    }

    const parsed = RecoveryCodeBody.safeParse(req.body ?? {});
    if (!parsed.success) throw badRequest("A recovery code is required");

    const normalized = repos.mfa.normalizeRecoveryCode(parsed.data.code);
    if (normalized.length === 0) throw badRequest("A recovery code is required");

    const now = new Date();
    const codeHash = repos.mfa.hashRecoveryCode(normalized);
    const consumed = await repos.mfa.consumeRecoveryCode(user.sub, codeHash, now);
    if (!consumed.ok) {
      await recordAuditEvent({
        req,
        actorUserId: user.sub,
        action: "mfa_recovery_failure",
        resourceType: "session",
        resourceId: user.jti,
        result: "failure",
        metadata: { method: "recovery", reason: consumed.reason },
      });
      // Nunca devuelve ni registra el código ni su hash.
      throw unauthorized("Invalid or already used recovery code");
    }

    const activeOrgId = await repos.memberships.getFirstOrgForUser(user.sub);
    const result = await repos.mfa.promotePendingSession({
      userSub: user.sub,
      pendingJti: user.jti,
      buildToken: (roles) =>
        signToken({
          sub: user.sub,
          email: user.email,
          name: user.name,
          roles,
          csrf: generateCsrfToken(),
        }),
      activeOrgId,
      now,
    });

    if (!result.ok) {
      throw unauthorized("Invalid or already used recovery code");
    }

    res.cookie(sessionCookieName(), result.jwt, sessionCookieOptions());
    await repos.users.updateLastLogin(user.sub);

    await recordAuditEvent({
      req,
      actorUserId: user.sub,
      action: "mfa_recovery_code_used",
      resourceType: "session",
      resourceId: user.jti,
      result: "success",
      metadata: { method: "recovery" },
    });

    res.status(200).json({ sub: user.sub, email: user.email, roles: result.roles });
  },
);

/**
 * POST /api/auth/mfa/disable — deshabilita MFA. Exige el TOTP actual (NO
 * acepta recovery code como sustituto). Sesión completa + CSRF + limit.
 * Limpia secreto/timestamps/step y elimina los recovery codes (atómico).
 */
router.post(
  "/mfa/disable",
  requireAuth(),
  requireMfaVerified(),
  mfaDisableLimiter,
  requireCsrf(),
  async (req, res) => {
    const user = (req as AuthedRequest).user;
    if (!user?.sub) throw unauthorized("Missing or invalid session");

    const parsed = TotpCodeBody.safeParse(req.body ?? {});
    if (!parsed.success) throw badRequest("code must be a 6-digit TOTP code");

    const state = await repos.mfa.getMfaState(user.sub);
    if (!state?.mfaEnabled || !state.mfaSecretEncrypted) {
      throw conflict("MFA is not enabled");
    }

    const now = new Date();
    let step: number | null = null;
    try {
      step = verifyTotp(decrypt(state.mfaSecretEncrypted), parsed.data.code, now.getTime());
    } catch {
      step = null;
    }
    if (step === null) {
      await recordAuditEvent({
        req,
        actorUserId: user.sub,
        action: "mfa_verification_failure",
        resourceType: "user",
        resourceId: user.sub,
        result: "failure",
        metadata: { method: "totp", context: "disable" },
      });
      throw badRequest("Invalid or expired TOTP code");
    }

    await repos.mfa.disableMfa(user.sub);

    await recordAuditEvent({
      req,
      actorUserId: user.sub,
      action: "mfa_disabled",
      resourceType: "user",
      resourceId: user.sub,
      result: "success",
      metadata: { method: "totp" },
    });

    res.status(200).json({ enabled: false });
  },
);

/**
 * POST /api/auth/mfa/recovery/regenerate — regenera los recovery codes.
 * Exige MFA habilitado + TOTP actual. Los 10 nuevos plaintext solo en esta
 * respuesta; los anteriores se eliminan (una transacción).
 */
router.post(
  "/mfa/recovery/regenerate",
  requireAuth(),
  requireMfaVerified(),
  mfaRegenerateLimiter,
  requireCsrf(),
  async (req, res) => {
    const user = (req as AuthedRequest).user;
    if (!user?.sub) throw unauthorized("Missing or invalid session");

    const parsed = TotpCodeBody.safeParse(req.body ?? {});
    if (!parsed.success) throw badRequest("code must be a 6-digit TOTP code");

    const state = await repos.mfa.getMfaState(user.sub);
    if (!state?.mfaEnabled || !state.mfaSecretEncrypted) {
      throw conflict("MFA is not enabled");
    }

    const now = new Date();
    let step: number | null = null;
    try {
      step = verifyTotp(decrypt(state.mfaSecretEncrypted), parsed.data.code, now.getTime());
    } catch {
      step = null;
    }
    if (step === null) {
      await recordAuditEvent({
        req,
        actorUserId: user.sub,
        action: "mfa_verification_failure",
        resourceType: "user",
        resourceId: user.sub,
        result: "failure",
        metadata: { method: "totp", context: "regenerate" },
      });
      throw badRequest("Invalid or expired TOTP code");
    }

    const recoveryCodes = await repos.mfa.regenerateRecoveryCodes(user.sub);

    await recordAuditEvent({
      req,
      actorUserId: user.sub,
      action: "mfa_recovery_codes_regenerated",
      resourceType: "user",
      resourceId: user.sub,
      result: "success",
      metadata: { method: "totp", count: recoveryCodes.length },
    });

    res.status(200).json({ recoveryCodes });
  },
);

export default router;
