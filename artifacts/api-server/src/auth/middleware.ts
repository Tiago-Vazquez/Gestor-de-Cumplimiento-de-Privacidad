import type { NextFunction, Request, Response } from "express";
import { forbidden, unauthorized } from "./errors";
import { extractSessionToken } from "./cookies";
import { authDisabled, JWT_ISSUER, verifyToken, type AuthTokenPayload } from "./tokens";
import { repos } from "../repositories";

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
    const activeSession = await repos.sessions.findActiveByJti(payload.jti);
    if (!activeSession) {
      res.set("WWW-Authenticate", WWW_AUTHENTICATE);
      throw unauthorized("Missing or invalid session");
    }

    (req as AuthedRequest).user = payload;
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