import type { NextFunction, Request, Response } from "express";
import { forbidden, unauthorized } from "./errors";
import { extractSessionToken } from "./cookies";
import { authDisabled, JWT_ISSUER, verifyToken, type AuthTokenPayload } from "./tokens";
import { repos } from "../repositories";
import { sessionIdleSeconds } from "../lib/env";
import { recordAuditEvent, type AuditAction } from "../lib/audit";

/**
 * M18 Fase 5 — auditoría del rechazo de una sesión por expiración o
 * inactividad. Solo distingue la razón cuando la fila existe y NO está
 * revocada (una revocación ya se audita en su propia acción; un `jti`
 * desconocido no aporta trazabilidad). Fire-and-forget: el 401 nunca depende
 * de que la auditoría persista; los errores técnicos van al log de M16.
 */
async function auditSessionRejection(
  req: Request,
  sub: string | undefined,
  jti: string,
  idleSeconds: number,
): Promise<void> {
  try {
    const raw = await repos.sessions.findRawByJti(jti);
    if (!raw || raw.revokedAt) {
      return;
    }
    const now = Date.now();
    const action: AuditAction | null =
      raw.expiresAt.getTime() <= now
        ? "session_expired"
        : now - raw.lastUsedAt.getTime() > idleSeconds * 1000
          ? "inactivity_timeout"
          : null;
    if (!action) {
      return;
    }
    await recordAuditEvent({
      req,
      actorUserId: sub ?? null,
      action,
      resourceType: "session",
      resourceId: jti,
      result: "failure",
      metadata: { reason: action },
    });
  } catch {
    // Best-effort: el rechazo de autenticación debe completarse igual.
  }
}

import { logger } from "../lib/logger";

/** Request autenticado: lleva el payload del JWT verificado en `req.user`. */
export interface AuthedRequest extends Request {
  user?: AuthTokenPayload;
}

const WWW_AUTHENTICATE = `Bearer realm="${JWT_ISSUER}"`;

/**
 * Exige autenticación. Orden de fallo:
 * - token ausente → 401 (WWW-Authenticate: Bearer)
 * - token inválido/expirado → 401
 * - token sin `jti` → 401
 * - token con `jti` sin sesión activa (inexistente, revocada o expirada) → 401
 * - ok → `req.user = payload`
 *
 * Allowlist de sesiones (revocables server-side): el JWT debe llevar `jti` y
 * existir una fila activa en `sessions`. La misma respuesta 401 cubre todos los
 * fallos para no filtrar cuál fue la causa.
 *
 * En dev/tests con `AUTH_DISABLED=true` se inyecta una identidad simulada
 * admin para que las suites que no cubran auth sigan pasando. En producción
 * el bypass NUNCA aplica (hardening 6.3B.7): `authDisabled()` devuelve false
 * cuando NODE_ENV=production y el startup lo rechaza (assertAuthConfigForEnv).
 */
export function requireAuth() {
  return async function requireAuthMiddleware(
    req: Request,
    res: Response,
    next: NextFunction,
  ): Promise<void> {
    if (authDisabled()) {
      (req as AuthedRequest).user = {
        sub: "dev-sub",
        email: "dev@local.test",
        name: "Dev User",
        roles: ["admin"],
      };
      next();
      return;
    }

    const token = extractSessionToken(req);
    if (!token) {
      res.set("WWW-Authenticate", WWW_AUTHENTICATE);
      throw unauthorized("Missing or invalid session");
    }

    const payload = await verifyToken(token);
    if (!payload) {
      res.set("WWW-Authenticate", WWW_AUTHENTICATE);
      throw unauthorized("Missing or invalid session");
    }

    // Allowlist de sesiones: el JWT debe llevar `jti` y existir una fila
    // activa en `sessions` (revocable server-side). Sin `jti` o sin sesión
    // activa → 401 (misma respuesta que el resto de fallos de auth).
    if (!payload.jti) {
      res.set("WWW-Authenticate", WWW_AUTHENTICATE);
      throw unauthorized("Missing or invalid session");
    }
    const idleSeconds = sessionIdleSeconds();
    const activeSession = await repos.sessions.findActiveByJti(payload.jti, idleSeconds);
    if (!activeSession) {
      res.set("WWW-Authenticate", WWW_AUTHENTICATE);
      void auditSessionRejection(req, payload.sub, payload.jti, idleSeconds);
      throw unauthorized("Missing or invalid session");
    }

    // Hardening 6.3B.23 (F23-03, defensa en profundidad): el JWT fue emitido
    // para un `sub`, la sesión allowlist pertenece a `session.userSub`. Si no
    // coinciden, el token fue reasignado/cambiamos de identidad → 401. La
    // respuesta es idéntica al resto de fallos de auth para no filtrar cuál
    // comprobación falló. `findActiveByJti` garantiza que la fila existe (if
    // previo) y que está activa (revoked_at IS NULL AND expires_at > now).
    if (activeSession.userSub !== payload.sub) {
      res.set("WWW-Authenticate", WWW_AUTHENTICATE);
      throw unauthorized("Missing or invalid session");
    }

    (req as AuthedRequest).user = payload;

    // M11.2.3 — refrescar timestamp de última actividad. Fallo no rompe el
    // request: si no podemos actualizar, es mejor dejar al usuario continuar
    // que bloquearlo. La expiración eventual manejará el cierre si la sesión
    // realmente está inactiva.
    try {
      await repos.sessions.touchLastUsed(payload.jti);
    } catch (err) {
      logger.warn(
        { jti: payload.jti, err },
        "Failed to update last_used_at",
      );
    }

    next();
  };
}

/**
 * Exige un rol concreto (p. ej. "admin") para mutaciones. Se usa después de
 * `requireAuth`; si la auth está desactivada en dev/tests se omite la
 * comprobación (la identidad simulada ya es admin).
 */
export function requireRole(role: string) {
  return async function requireRoleMiddleware(
    req: Request,
    _res: Response,
    next: NextFunction,
  ): Promise<void> {
    if (authDisabled()) {
      next();
      return;
    }
    const user = (req as AuthedRequest).user;
    if (user && user.roles.includes(role)) {
      next();
      return;
    }
    throw forbidden(`${role} role required`);
  };
}