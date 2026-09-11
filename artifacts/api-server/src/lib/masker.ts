import { createHmac } from "node:crypto";

/**
 * M5.b — Tokenizador determinista y puro para anonimización de datos.
 *
 * Garantías de diseño (contrato):
 *   - mismo valor + misma clave → mismo token (HMAC-SHA256).
 *   - es una función pura: sin BD, sin IO, sin reloj, sin estado global.
 *   - preserva el formato de entrada cuando es técnicamente razonable.
 *
 * Origen de la clave (M5.b, decisión):
 *   El tokenizador NO lee secretos por sí mismo (puro ⇒ sin IO). En su lugar,
 *   `deriveMaskerKey(masterSecret)` deriva una subclave de dominio estable a
 *   partir del secreto maestro de la plataforma. La integración (M5.c/d) pasará
 *   `SOURCE_ENCRYPTION_KEY` (la MISMA variable que ya alimenta `secret-manager`,
 *   fail-fast en producción, se nunca loguea ni se expone al frontend), de modo
 *   que la clave es estable entre ejecuciones, nunca hardcodeada, y no se
 *   regenera por proceso.
 *
 * Tipos soportados en esta fase: `email`, `phone`, `national_id`, `credit_card`.
 * NO se define política para otros tipos: `maskValue` rechaza cualquier campo
 * no soportado (no se inventa una anonimización sin justificación).
 */

export type MaskableField = "email" | "phone" | "national_id" | "credit_card";

/** Catálogo de campos con política de anonimización definida (M5.b). */
export const MASKABLE_FIELDS: readonly MaskableField[] = [
  "email",
  "phone",
  "national_id",
  "credit_card",
];

const MASKER_DOMAIN = "masker:v1";
const EMAIL_LOCAL_SEPARATORS = new Set([".", "_", "+", "-"]);

/**
 * Deriva la subclave de anonimización (64 hex = 256 bits) desde el secreto
 * maestro. Determinista: mismo `masterSecret` → misma subclave. No lee el
 * entorno: la decisión de dónde sale el secreto pertenece al llamador.
 */
export function deriveMaskerKey(masterSecret: string): string {
  return createHmac("sha256", masterSecret)
    .update(MASKER_DOMAIN)
    .digest("hex");
}

/**
 * Devuelve un flujo determinista de bytes (0..255) derivado por HMAC.
 * `seed` diferencia el contexto (campo + alguna información del valor);
 * el contador estira el bloque si se necesitan más bytes que el digest.
 */
function deriveBytes(key: string, seed: string, length: number): number[] {
  const bytes: number[] = [];
  let counter = 0;
  while (bytes.length < length) {
    const block = createHmac("sha256", key).update(`${seed}:${counter}`).digest();
    for (const byte of block) {
      bytes.push(byte);
      if (bytes.length === length) break;
    }
    counter += 1;
  }
  return bytes;
}

/**
 * Máscara principal: tokeniza `value` para el campo indicado.
 *
 * - `email`: reemplaza el local-part carácter a carácter (letras→letras
 *   preservando mayúscula/minúscula, dígitos→dígitos, y preserva los
 *   separadores `. _ + -`); el dominio y el `@` se conservan para mantener
 *   el formato legible. Si no hay `@` (formato no reconocible), tokeniza la
 *   cadena completa con la misma estrategia (nunca deja PII sin proteger).
 * - `phone`/`national_id`/`credit_card`: cada dígito se sustituye por un
 *   dígito determinista y TODOS los separadores (espacio, `+`, `-`, `.`, `()`)
 *   se conservan → misma longitud y misma estructura que el original.
 *
 * Valores vacíos se devuelven tal cual. Valores de campos no soportados
 * lanzan `RangeError` (política explícita, no se improvisa una estrategia).
 */
export function maskValue(value: string, field: MaskableField, key: string): string {
  if (value.length === 0) return value;
  switch (field) {
    case "email":
      return maskEmail(value, key);
    case "phone":
    case "national_id":
    case "credit_card":
      return maskDigitsPreservingSeparators(value, field, key);
    default:
      throw new RangeError(`No masking policy for field: ${field}`);
  }
}

function maskEmail(value: string, key: string): string {
  const at = value.lastIndexOf("@");
  if (at === -1) {
    // Formato no reconocible: se tokeniza igualmente la cadena completa,
    // preservando la clase de cada carácter (protección por defecto).
    return maskLocalPart(value, key);
  }
  const local = value.slice(0, at);
  const domain = value.slice(at + 1);
  return `${maskLocalPart(local, key)}@${domain}`;
}

function maskLocalPart(local: string, key: string): string {
  const bytes = deriveBytes(key, `maskEmail:${local}`, local.length);
  let out = "";
  let byteIndex = 0;
  for (const char of local) {
    if (/[a-z]/.test(char)) {
      out += String.fromCharCode(97 + (bytes[byteIndex]! % 26));
      byteIndex += 1;
    } else if (/[A-Z]/.test(char)) {
      out += String.fromCharCode(65 + (bytes[byteIndex]! % 26));
      byteIndex += 1;
    } else if (/[0-9]/.test(char)) {
      out += String.fromCharCode(48 + (bytes[byteIndex]! % 10));
      byteIndex += 1;
    } else if (EMAIL_LOCAL_SEPARATORS.has(char)) {
      out += char;
    } else {
      out += char;
    }
  }
  return out;
}

function maskDigitsPreservingSeparators(value: string, field: string, key: string): string {
  let digitCount = 0;
  for (const char of value) {
    if (char >= "0" && char <= "9") digitCount += 1;
  }
  if (digitCount === 0) return value;
  // El valor va en el seed: valores distintos → streams de bytes distintos,
  // incluso con la MISMA cantidad de dígitos (HMAC de un solo sentido).
  const bytes = deriveBytes(key, `maskDigits:${field}:${value}`, digitCount);
  let byteIndex = 0;
  let out = "";
  for (const char of value) {
    if (char >= "0" && char <= "9") {
      out += String.fromCharCode(48 + (bytes[byteIndex]! % 10));
      byteIndex += 1;
    } else {
      out += char;
    }
  }
  return out;
}