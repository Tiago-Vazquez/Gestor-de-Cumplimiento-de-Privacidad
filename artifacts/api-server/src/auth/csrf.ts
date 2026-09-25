import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { NextFunction, Request, Response } from "express";
import { authDisabled } from "./tokens";
import { readRequestCookie, sessionCookieName } from "./cookies";
import { AuthedRequest } from "./middleware";
import { forbidden } from "../lib/errors";

/**
 * Protección CSRF por synchronizer token ligado a la sesión (M11.1).
 *
 * El token se genera en el login y viaja FIRMADO dentro del claim `csrf` del
 * JWT de sesión. Al ser parte del JWT está unívocamente asociado al `jti` de
 * esa sesión: un token de otra sesión nunca coincide, un token manipulado
 * rompe la firma del JWT y al revocar la sesión (logout) el token pierde toda
 * validez. El frontend lo obtiene por `GET /api/csrf-token` (autenticado) y lo
 * reenvía en el header `X-CSRF-Token` de cada mutación.
 *
 * El middleware central exige el header en POST/PUT/PATCH/DELETE cuando la
 * sesión viaja por cookie de navegador (escenario CSRF). Requests autenticados
 * solo con `Authorization: Bearer` (clientes no-navegador, server-to-server)
 * no son vulnerables a CSRF y quedan exentos. GET/HEAD/OPTIONS nunca exigen
 * token. En modos con `AUTH_DISABLED=true` (dev/test) se omite por completo,
 * igual que `requireAuth`/`requireRole`.
 */

export const CSRF_HEADER_NAME = "X-CSRF-Token";
const CSRF_BYTES = 32; // 256 bits de entropía
const CSRF_MUTATING_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

/** Genera un token CSRF criptográficamente aleatorio (base64url de 32 bytes). */
export function generateCsrfToken(): string {
  return randomBytes(CSRF_BYTES).toString("base64url");
}

/**
 * Comparación en tiempo constante. Hashea ambos valores con SHA-256 antes de
 * comparar para que ambos buffers tengan SIEMPRE 32 bytes: no se filtra ni la
 * longitud ni el contenido por timing (mitigación de timing attacks).
 */
export function csrfTokenMatches(provided: string, expected: string): boolean {
  const digest = (value: string) => createHash("sha256").update(value).digest();
  return timingSafeEqual(digest(provided), digest(expected));
}

import { recordAuditEvent } from "../lib/audit";

/**
 * M18 Fase 5 — auditoría best-effort de violaciones CSRF sobre sesiones
 * autenticadas (por cookie). Sin secretos: solo razón, método y ruta. Solo se
 * registra con sesión resuelta (`req.user`), para no amplificar basura
 * anónima en la tabla de auditoría.
 */
function auditCsrfViolation(req: Request, reason: string): void {
  void recordAuditEvent({
    req,
    action: "security_violation",
    resourceType: "session",
    result: "failure",
    metadata: { reason, method: req.method, route: req.path },
  }).catch(() => undefined);
}

/**
 * Middleware CSRF centralizado. Debe montarse DESPUÉS de que `requireAuth`
 * resolvió la sesión (`req.user`) y ANTES de los handlers mutativos.
 */
export function requireCsrf() {
  return async function requireCsrfMiddleware(
    req: Request,
    _res: Response,
    next: NextFunction,
  ): Promise<void> {
    if (authDisabled()) {
      next();
      return;
    }

    // Solo mutaciones del navegador (cookie). GET/HEAD/OPTIONS nunca se exigen.
    if (!CSRF_MUTATING_METHODS.has(req.method)) {
      next();
      return;
    }

    // La sesión debe viajar por cookie de sesión (escenario CSRF). Si el
    // request se autenticó solo con `Authorization: Bearer` no hay cookie que
    // un sitio externo pueda forzar a enviar, por lo que CSRF no aplica.
    if (!readRequestCookie(req, sessionCookieName())) {
      next();
      return;
    }

    const expected = (req as AuthedRequest).user?.csrf;
    if (typeof expected !== "string" || expected.length === 0) {
      // Fail-closed: sesión sin claim csrf (emitida sin M11.1) no puede mutar.
      void auditCsrfViolation(req, "csrf_claim_missing");
      throw forbidden("CSRF token required");
    }

    const provided = req.headers[CSRF_HEADER_NAME.toLowerCase()];
    if (typeof provided !== "string" || !csrfTokenMatches(provided, expected)) {
      // Respuesta idéntica para ausencia/token incorrecto: no filtra cuál.
      void auditCsrfViolation(req, "csrf_token_invalid");
      throw forbidden("CSRF token required");
    }

    next();
  };
}