import { randomUUID } from "node:crypto";
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
  /** JWT ID opcional para identificación única de sesión (revocación futura). */
  jti?: string;
};

/**
 * Interpretación única de NODE_ENV=production (fuente de verdad compartida
 * por authDisabled() y assertAuthConfigForEnv()).
 */
export function isProductionEnv(): boolean {
  return process.env.NODE_ENV === "production";
}

/** AUTH_DISABLED=true|1 pide desactivar la autenticación (solo dev/tests). */
function authDisabledRaw(): boolean {
  const raw = process.env.AUTH_DISABLED;
  return raw === "true" || raw === "1";
}

/**
 * La autenticación está desactivada solo si AUTH_DISABLED=true|1.
 * Hardening 6.3B.7 (fail-closed): en producción el bypass NUNCA aplica,
 * aunque la variable llegue accidentalmente al entorno — defensa en
 * profundidad usada por requireAuth/requireRole.
 */
export function authDisabled(): boolean {
  return authDisabledRaw() && !isProductionEnv();
}

/**
 * Guard de configuración fail-fast para el arranque del servidor: en
 * producción, AUTH_DISABLED=true es una configuración prohibida (sería un
 * bypass total de autenticación/autorización) y aborta el startup con un
 * error claro. No expone secretos (solo nombres de variables).
 */
export function assertAuthConfigForEnv(): void {
  if (authDisabledRaw() && isProductionEnv()) {
    throw new Error(
      "AUTH_DISABLED=true is forbidden when NODE_ENV=production: refusing to start with authentication/authorization bypassed. Remove AUTH_DISABLED or set it to false.",
    );
  }
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
  options?: { expiresInSeconds?: number; jti?: string },
): Promise<string> {
  const expiresIn = options?.expiresInSeconds ?? defaultExpiresInSeconds();
  const jti = options?.jti ?? randomUUID();
  return new SignJWT({
    email: payload.email ?? null,
    name: payload.name ?? null,
    roles: payload.roles,
    jti,
  })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(payload.sub)
    .setIssuedAt()
    .setIssuer(JWT_ISSUER)
    .setAudience(JWT_AUDIENCE)
    .setJti(jti)
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
      jti: typeof payload.jti === "string" ? payload.jti : undefined,
    };
  } catch {
    return null;
  }
}