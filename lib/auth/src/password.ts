import { randomBytes, scrypt, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";

const scryptAsync = promisify(scrypt) as (
  password: string,
  salt: Buffer,
  keylen: number,
  options: { N: number; r: number; p: number },
) => Promise<Buffer>;

// Parámetros scrypt: N=16384, r=8, p=1 son recomendaciones OWASP para la mayoría
// de aplicaciones. Producen un hash de 64 bytes. El salt es de 32 bytes.
const SCRYPT_N = 16384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const KEYLEN = 64;
const SALT_BYTES = 32;

// Formato del hash almacenado: scrypt$N$r$p$salt$hash (todo en base64url)
const HASH_VERSION = "scrypt";

/**
 * Genera un hash seguro de la contraseña usando scrypt con salt aleatorio.
 * El resultado incluye todos los parámetros necesarios para verificación futura.
 */
export async function hashPassword(password: string): Promise<string> {
  if (typeof password !== "string" || password.length === 0) {
    throw new Error("Password must be a non-empty string");
  }

  const salt = randomBytes(SALT_BYTES);
  const derived = await scryptAsync(password, salt, KEYLEN, {
    N: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P,
  });

  const saltB64 = salt.toString("base64url");
  const hashB64 = derived.toString("base64url");

  return `${HASH_VERSION}$${SCRYPT_N}$${SCRYPT_R}$${SCRYPT_P}$${saltB64}$${hashB64}`;
}

/**
 * Verifica una contraseña contra un hash almacenado.
 * Usa comparación en tiempo constante para evitar ataques de timing.
 * Retorna false si el hash es inválido o la contraseña no coincide.
 */
export async function verifyPassword(
  password: string,
  storedHash: string,
): Promise<boolean> {
  if (typeof password !== "string" || password.length === 0) {
    return false;
  }
  if (typeof storedHash !== "string" || storedHash.length === 0) {
    return false;
  }

  const parts = storedHash.split("$");
  // Formato esperado: scrypt$N$r$p$salt$hash
  if (parts.length !== 6 || parts[0] !== HASH_VERSION) {
    return false;
  }

  const N = Number(parts[1]);
  const r = Number(parts[2]);
  const p = Number(parts[3]);
  const salt = Buffer.from(parts[4], "base64url");
  const expectedHash = Buffer.from(parts[5], "base64url");

  if (!Number.isFinite(N) || !Number.isFinite(r) || !Number.isFinite(p)) {
    return false;
  }
  if (salt.length === 0 || expectedHash.length === 0) {
    return false;
  }

  try {
    const derived = await scryptAsync(password, salt, expectedHash.length, {
      N,
      r,
      p,
    });

    if (derived.length !== expectedHash.length) {
      return false;
    }
    return timingSafeEqual(derived, expectedHash);
  } catch {
    return false;
  }
}
