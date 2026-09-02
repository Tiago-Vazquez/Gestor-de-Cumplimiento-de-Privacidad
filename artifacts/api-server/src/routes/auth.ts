import { timingSafeEqual } from "node:crypto";
import { Router, type IRouter } from "express";
import { rateLimit } from "express-rate-limit";
import { logger } from "../lib/logger";
import { repos } from "../repositories";
import { signToken } from "../auth/tokens";
import { requireAuth, type AuthedRequest } from "../auth/middleware";
import {
  sessionCookieName,
  sessionCookieOptions,
} from "../auth/cookies";
import { badRequest, unauthorized } from "../lib/errors";
import { sendProblemJson } from "../lib/problem-json";

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
 * Rate limit específico para login: máximo 5 intentos por IP cada 15 minutos.
 * Protege contra ataques de fuerza bruta sobre el bootstrap token sin
 * afectar al rate limiter general de la API.
 */
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
});

/**
 * POST /api/auth/login
 * Intercambia un bootstrap token (de un solo uso en el arranque) por una sesión
 * JWT con cookie httpOnly. Crea/actualiza al usuario y le asigna rol admin.
 */
router.post("/login", loginLimiter, async (req, res) => {
  const provided = (req.body ?? {}).token;
  if (typeof provided !== "string" || provided.length === 0) {
    throw badRequest("Missing bootstrap token in request body");
  }

  if (!compareBootstrapToken(provided)) {
    throw unauthorized("Invalid bootstrap token");
  }

  // Persistir/actualizar al usuario y asegurar rol admin (idempotente).
  const user = await repos.users.upsertBySub({
    sub: BOOTSTRAP_SUB,
    email: BOOTSTRAP_EMAIL,
    name: BOOTSTRAP_NAME,
  });
  await repos.userRoles.addRole(user.sub, "admin");

  const jwt = await signToken({
    sub: user.sub,
    email: user.email,
    name: user.name,
    roles: ["admin"],
  });

  res.cookie(sessionCookieName(), jwt, sessionCookieOptions());

  // Auditoría: se registra el login exitoso, NUNCA el token/JWT.
  logger.info({ sub: user.sub, event: "login" }, "User logged in");

  res.status(200).json({
    sub: user.sub,
    email: user.email,
    roles: ["admin"],
  });
});

/**
 * POST /api/auth/logout
 * No requiere autenticación estricta: permite cerrar sesión aunque el JWT haya
 * expirado. Simplemente invalida la cookie de sesión.
 */
router.post("/logout", (_req, res) => {
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