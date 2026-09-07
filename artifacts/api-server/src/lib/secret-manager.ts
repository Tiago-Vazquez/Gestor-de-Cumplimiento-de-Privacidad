import crypto from "node:crypto";

/**
 * Secret Manager para cifrado/descifrado de credenciales de fuentes externas.
 *
 * FASE 7.0.0: AES-256-GCM autenticado con:
 * - IV aleatorio de 12 bytes por cifrado (nonce)
 * - Authentication tag de 16 bytes (integridad)
 * - Formato: iv:tag:ciphertext (base64 concatenado con ':')
 *
 * La clave se deriva de SOURCE_ENCRYPTION_KEY mediante SHA-256.
 * En producción, la ausencia de clave es fail-closed (throw).
 */

const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 12;
const TAG_LENGTH = 16;
const KEY_LENGTH = 32;
const ENCODING = "base64";
const MIN_KEY_LENGTH = 32; // FASE 7.0.5 (M9): mínimo de seguridad para la clave de cifrado

/**
 * FASE 7.0.5 (M9): fail-fast en startup para la clave de cifrado de fuentes.
 *
 * En producción, `SOURCE_ENCRYPTION_KEY` es obligatoria y debe tener al menos
 * 32 caracteres (simétrico a JWT_SECRET). Si falta o es demasiado corta, se
 * aborta el arranque antes de abrir el puerto.
 *
 * En development/test, si falta la clave se emite un warning y se continúa
 * (no rompe tests existentes ni el flujo local).
 */
export function assertSourceEncryptionKeyForEnv(): void {
  const raw = process.env.SOURCE_ENCRYPTION_KEY;
  const isProduction = process.env.NODE_ENV === "production";

  if (!raw || raw.length < MIN_KEY_LENGTH) {
    if (isProduction) {
      throw new Error(
        `SOURCE_ENCRYPTION_KEY is required in production and must be at least ${MIN_KEY_LENGTH} characters long.`,
      );
    }
    // eslint-disable-next-line no-console
    console.warn(
      `[privacy-scanner] SOURCE_ENCRYPTION_KEY is missing or too short (< ${MIN_KEY_LENGTH} chars); ` +
        "source connection configs will not be encrypted. This is acceptable in development/test only.",
    );
    return;
  }
}

function deriveKey(): Buffer {
  const raw = process.env.SOURCE_ENCRYPTION_KEY;
  if (!raw) {
    throw new Error("SOURCE_ENCRYPTION_KEY is not configured");
  }
  // Derivar clave de 32 bytes desde el secreto (no usar raw directamente)
  return crypto.createHash("sha256").update(raw).digest();
}

export function encrypt(plaintext: string): string {
  const key = deriveKey();
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);

  const encrypted = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();

  // Formato: iv:tag:ciphertext (todo base64)
  return [iv.toString(ENCODING), tag.toString(ENCODING), encrypted.toString(ENCODING)].join(":");
}

export function decrypt(ciphertext: string): string {
  const key = deriveKey();
  const parts = ciphertext.split(":");
  if (parts.length !== 3) {
    throw new Error("Invalid ciphertext format");
  }

  const [ivB64, tagB64, dataB64] = parts;
  const iv = Buffer.from(ivB64, ENCODING);
  const tag = Buffer.from(tagB64, ENCODING);
  const data = Buffer.from(dataB64, ENCODING);

  if (iv.length !== IV_LENGTH || tag.length !== TAG_LENGTH) {
    throw new Error("Invalid ciphertext: IV or tag length mismatch");
  }

  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(tag);

  const decrypted = Buffer.concat([decipher.update(data), decipher.final()]);
  return decrypted.toString("utf8");
}

/**
 * Verifica si el cifrado está configurado (para fail-closed en producción).
 * FASE 7.0.5: usa MIN_KEY_LENGTH para consistencia con assertSourceEncryptionKeyForEnv.
 */
export function isEncryptionConfigured(): boolean {
  const raw = process.env.SOURCE_ENCRYPTION_KEY;
  return typeof raw === "string" && raw.length >= MIN_KEY_LENGTH;
}