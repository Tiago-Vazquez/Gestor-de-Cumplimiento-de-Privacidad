import type { Request } from "express";

/**
 * Gestión de la cookie de sesión. La firma del token sigue stateless; la
 * cookie solo la transporta en navegadores. Se acepta también `Authorization:
 * Bearer` (clientes no-navegador). `httpOnly` impide leerla desde JS.
 */
export const SESSION_COOKIE_NAME = "session";

export function sessionCookieName(): string {
  return process.env.SESSION_COOKIE ?? SESSION_COOKIE_NAME;
}

export function sessionCookieOptions() {
  return {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax" as const,
    path: "/",
  };
}

/** Extrae una cookie del header `Cookie` (no se usa cookie-parser). */
export function readRequestCookie(req: Request, name: string): string | undefined {
  const header = req.headers.cookie;
  if (!header) return undefined;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    const key = part.slice(0, eq).trim();
    if (key === name) {
      try {
        return decodeURIComponent(part.slice(eq + 1).trim());
      } catch {
        return undefined;
      }
    }
  }
  return undefined;
}

/** Devuelve el token de sesión del request (Bearer o cookie). */
export function extractSessionToken(req: Request): string | null {
  const authorization = req.headers.authorization;
  if (authorization && authorization.startsWith("Bearer ")) {
    const token = authorization.slice("Bearer ".length).trim();
    return token.length > 0 ? token : null;
  }
  const fromCookie = readRequestCookie(req, sessionCookieName());
  return fromCookie && fromCookie.length > 0 ? fromCookie : null;
}