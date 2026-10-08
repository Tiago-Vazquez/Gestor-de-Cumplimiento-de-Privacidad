import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * TOTP (RFC 6238) sobre HOTP (RFC 4226) con HMAC-SHA1.
 *
 * Implementación propia con `node:crypto`, sin dependencias externas. Produce
 * códigos de 6 dígitos con periodo de 30 segundos y ventana ±1 para tolerancia
 * de reloj. El anti-replay se resuelve fuera de este módulo (en `mfa.repo.ts` y
 * las rutas, vía `mfa_last_verified_step`), usando el time-step devuelto por
 * `verifyTotp`.
 */

const DIGITS = 6;
const PERIOD_SECONDS = 30;
const WINDOW = 1;

const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

function base32Encode(bytes: Buffer): string {
  let bits = 0;
  let value = 0;
  let output = "";
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) {
    output += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  }
  return output;
}

function base32Decode(input: string): Buffer {
  const clean = input.toUpperCase().replace(/[^A-Z2-7]/g, "");
  const bytes: number[] = [];
  let bits = 0;
  let value = 0;
  for (const char of clean) {
    const index = BASE32_ALPHABET.indexOf(char);
    if (index === -1) continue;
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(bytes);
}

/** Genera un secreto TOTP de 20 bytes (160 bits) en base32. */
export function generateTotpSecret(): string {
  return base32Encode(randomBytes(20));
}

/** Contador de 64 bits big-endian (RFC 4226 step 1). */
function counterToBuffer(counter: number): Buffer {
  const buffer = Buffer.alloc(8);
  buffer.writeUInt32BE(Math.floor(counter / 0x100000000), 0);
  buffer.writeUInt32BE(counter >>> 0, 4);
  return buffer;
}

/** HOTP (RFC 4226): HMAC-SHA1 + truncación dinámica → código de `digits`. */
function hotp(secret: Buffer, counter: number, digits: number): string {
  const hmac = createHmac("sha1", secret)
    .update(counterToBuffer(counter))
    .digest();
  const offset = hmac[hmac.length - 1] & 0x0f;
  const binary =
    ((hmac[offset] & 0x7f) << 24) |
    ((hmac[offset + 1] & 0xff) << 16) |
    ((hmac[offset + 2] & 0xff) << 8) |
    (hmac[offset + 3] & 0xff);
  const code = binary % 10 ** digits;
  return code.toString().padStart(digits, "0");
}

/** Time-step actual (RFC 6238): floor(unixSeconds / period). */
export function currentTotpStep(now: number = Date.now()): number {
  return Math.floor(now / 1000 / PERIOD_SECONDS);
}

/**
 * Verifica un código TOTP contra un secreto base32 dentro de la ventana ±1.
 * Devuelve el time-step aceptado (para anti-replay) o null si no coincide.
 */
export function verifyTotp(
  secretBase32: string,
  code: string,
  now: number = Date.now(),
): number | null {
  if (!/^\d{6}$/.test(code)) return null;
  const secret = base32Decode(secretBase32);
  if (secret.length === 0) return null;
  const step = currentTotpStep(now);
  const provided = Buffer.from(code);
  for (let offset = -WINDOW; offset <= WINDOW; offset++) {
    const expected = Buffer.from(hotp(secret, step + offset, DIGITS));
    if (timingSafeEqual(provided, expected)) {
      return step + offset;
    }
  }
  return null;
}

/** URI `otpauth://` para el QR / entrada manual. */
export function buildOtpauthUrl(params: {
  issuer: string;
  account: string;
  secretBase32: string;
}): string {
  const { issuer, account, secretBase32 } = params;
  const label = encodeURIComponent(`${issuer}:${account}`);
  return (
    `otpauth://totp/${label}` +
    `?secret=${secretBase32}` +
    `&issuer=${encodeURIComponent(issuer)}` +
    `&algorithm=SHA1&digits=${DIGITS}&period=${PERIOD_SECONDS}`
  );
}

export { DIGITS as TOTP_DIGITS, PERIOD_SECONDS as TOTP_PERIOD_SECONDS };
