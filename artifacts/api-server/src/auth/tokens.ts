import { SignJWT, jwtVerify } from "jose";
import { TextEncoder } from "node:util";

/**
 * Emisión y verificación de JWT (HS256, stateless) para autenticación.
 * Los secretos y parámetros se leen del entorno en cada llamada, de modo que
 * los tests pueden cambiarlos por archivo sin problemas de hoisting.
 */

export const JWT_ISSUER = "privacy-compliance-manager";
export const JWT_AUDIENCE = "privacy-compliance-manager";

export type AuthTokenPayload = {
  /** Identificador estable del usuario (clave primaria en la tabla users). */
  sub: string;
  email: string | null;
  name: string | null;
  roles: string[];
};

/** La autenticación está desactivada solo si AUTH_DISABLED=true|1. */
export function authDisabled(): boolean {
  const raw = process.env.AUTH_DISABLED;
  return raw === "true" || raw === "1";
}

function requireSecret(): Uint8Array {
  const secret = process.env.JWT_SECRET;
  if (!secret || secret.length < 32) {
    throw new Error(
      "JWT_SECRET must be set (at least 32 chars) unless AUTH_DISABLED=true",
    );
  }
  return new TextEncoder().encode(secret);
}

export function defaultExpiresInSeconds(): number {
  const raw = process.env.JWT_EXPIRES_IN;
  if (!raw) return 8 * 60 * 60; // 8h
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? value : 8 * 60 * 60;
}

export async function signToken(
  payload: AuthTokenPayload,
  options?: { expiresInSeconds?: number },
): Promise<string> {
  const expiresIn = options?.expiresInSeconds ?? defaultExpiresInSeconds();
  return new SignJWT({
    email: payload.email ?? null,
    name: payload.name ?? null,
    roles: payload.roles,
  })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(payload.sub)
    .setIssuedAt()
    .setIssuer(JWT_ISSUER)
    .setAudience(JWT_AUDIENCE)
    .setExpirationTime(`${expiresIn}s`)
    .sign(requireSecret());
}

/**
 * Verifica firma, issuer, audience y expiración. Devuelve null si el token es
 * inválido o ha caducado (nunca lanza: el middleware traduce null → 401).
 */
export async function verifyToken(token: string): Promise<AuthTokenPayload | null> {
  try {
    const { payload } = await jwtVerify(token, requireSecret(), {
      issuer: JWT_ISSUER,
      audience: JWT_AUDIENCE,
    });
    const sub = typeof payload.sub === "string" ? payload.sub : "";
    if (!sub) return null;
    const roles = Array.isArray(payload.roles)
      ? payload.roles.filter((role): role is string => typeof role === "string")
      : [];
    return {
      sub,
      email: typeof payload.email === "string" ? payload.email : null,
      name: typeof payload.name === "string" ? payload.name : null,
      roles,
    };
  } catch {
    return null;
  }
}