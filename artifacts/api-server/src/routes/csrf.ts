import { Router, type IRouter } from "express";
import { decodeJwt } from "jose";
import { requireAuth, type AuthedRequest } from "../auth/middleware";
import {
  extractSessionToken,
  sessionCookieName,
  sessionCookieOptions,
} from "../auth/cookies";
import { generateCsrfToken } from "../auth/csrf";
import { signToken } from "../auth/tokens";
import { unauthorized } from "../lib/errors";

/**
 * GET /api/csrf-token
 *
 * Devuelve SOLO el token CSRF de synchronizer de la sesión autenticada actual
 * (M11.1). El token se generó firmado dentro del JWT en el login; aquí solo se
 * lee del payload ya verificado por `requireAuth` (nunca se escribe en logs).
 *
 * Contrato:
 * - Requiere sesión autenticada: sin sesión válida → 401 (no crea sesión).
 * - Si la sesión aún no tiene claim `csrf` (JWT emitido sin M11.1), lo
 *   inicializa UNA única vez re-firmando el mismo JWT (mismo `jti` y `exp`)
 *   con el claim añadido y reenviando la cookie; requests posteriores de la
 *   misma sesión reutilizan ese mismo token.
 * - Devuelve únicamente `{ csrfToken }`, sin datos de sesión ni secretos.
 */
const router: IRouter = Router();

router.get("/", requireAuth(), async (req, res) => {
  const user = (req as AuthedRequest).user;
  if (!user) {
    throw unauthorized("Missing or invalid session");
  }

  let csrf = user.csrf;
  if (typeof csrf !== "string" || csrf.length === 0) {
    const token = extractSessionToken(req);
    if (!token) {
      throw unauthorized("Missing or invalid session");
    }

    const decoded = decodeJwt(token);
    const exp = typeof decoded.exp === "number" ? decoded.exp : undefined;
    const expiresInSeconds =
      exp ? Math.max(1, Math.round((exp * 1000 - Date.now()) / 1000)) : undefined;

    csrf = generateCsrfToken();
    const refreshed = await signToken(
      {
        sub: user.sub,
        email: user.email,
        name: user.name,
        roles: user.roles,
        csrf,
      },
      { jti: user.jti, expiresInSeconds },
    );
    res.cookie(sessionCookieName(), refreshed, sessionCookieOptions());
  }

  res.status(200).json({ csrfToken: csrf });
});

export default router;