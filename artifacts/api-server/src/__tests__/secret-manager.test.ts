import { describe, it, expect, afterEach } from "vitest";
import { encrypt, decrypt, isEncryptionConfigured } from "../lib/secret-manager";

/**
 * FASE 7.0.0 — Tests de cifrado AES-256-GCM para credenciales de fuentes.
 *
 * Roundtrip, no-determinismo (IV aleatorio), integridad (auth tag),
 * formato inválido, key ausente (fail-closed).
 */

const VALID_KEY = "test-source-encryption-key-of-32-chars!!";

describe("secret-manager: AES-256-GCM", () => {
  const originalKey = process.env.SOURCE_ENCRYPTION_KEY;

  afterEach(() => {
    if (originalKey === undefined) {
      delete process.env.SOURCE_ENCRYPTION_KEY;
    } else {
      process.env.SOURCE_ENCRYPTION_KEY = originalKey;
    }
  });

  it("encrypt/decrypt roundtrip", () => {
    process.env.SOURCE_ENCRYPTION_KEY = VALID_KEY;
    const plaintext = "super-secret-password-123";
    const ciphertext = encrypt(plaintext);
    expect(decrypt(ciphertext)).toBe(plaintext);
  });

  it("ciphertext es no-determinista (IV aleatorio por cifrado)", () => {
    process.env.SOURCE_ENCRYPTION_KEY = VALID_KEY;
    const plaintext = "same-input";
    const a = encrypt(plaintext);
    const b = encrypt(plaintext);
    expect(a).not.toBe(b);
    expect(decrypt(a)).toBe(plaintext);
    expect(decrypt(b)).toBe(plaintext);
  });

  it("formato ciphertext es iv:tag:data (3 partes base64)", () => {
    process.env.SOURCE_ENCRYPTION_KEY = VALID_KEY;
    const ciphertext = encrypt("test");
    const parts = ciphertext.split(":");
    expect(parts).toHaveLength(3);
    parts.forEach((p) => {
      expect(Buffer.from(p, "base64").toString("base64")).toBe(p);
    });
  });

  it("ciphertext manipulado → decrypt lanza error (auth tag mismatch)", () => {
    process.env.SOURCE_ENCRYPTION_KEY = VALID_KEY;
    const ciphertext = encrypt("sensitive-data");
    const parts = ciphertext.split(":");
    // Corromper el tag (parte 2)
    const corruptedTag = parts[1] === "AAAA" ? "BBBB" : "AAAA";
    const corrupted = [parts[0], corruptedTag, parts[2]].join(":");
    expect(() => decrypt(corrupted)).toThrow();
  });

  it("formato inválido (menos de 3 partes) → error", () => {
    process.env.SOURCE_ENCRYPTION_KEY = VALID_KEY;
    expect(() => decrypt("iv:data")).toThrow();
  });

  it("formato inválido (más de 3 partes) → error", () => {
    process.env.SOURCE_ENCRYPTION_KEY = VALID_KEY;
    expect(() => decrypt("a:b:c:d")).toThrow();
  });

  it("plaintext vacío → cifra y descifra correctamente", () => {
    process.env.SOURCE_ENCRYPTION_KEY = VALID_KEY;
    const ciphertext = encrypt("");
    expect(decrypt(ciphertext)).toBe("");
  });

  it("plaintext largo → roundtrip correcto", () => {
    process.env.SOURCE_ENCRYPTION_KEY = VALID_KEY;
    const plaintext = "x".repeat(10_000);
    expect(decrypt(encrypt(plaintext))).toBe(plaintext);
  });

  it("caracteres especiales/UTF-8 → roundtrip correcto", () => {
    process.env.SOURCE_ENCRYPTION_KEY = VALID_KEY;
    const plaintext = "p@$$w0rd!#%^&*()áéíóúñ中文🔒";
    expect(decrypt(encrypt(plaintext))).toBe(plaintext);
  });
});

describe("secret-manager: fail-closed", () => {
  const originalKey = process.env.SOURCE_ENCRYPTION_KEY;

  afterEach(() => {
    if (originalKey === undefined) {
      delete process.env.SOURCE_ENCRYPTION_KEY;
    } else {
      process.env.SOURCE_ENCRYPTION_KEY = originalKey;
    }
  });

  it("isEncryptionConfigured() → true cuando la key existe", () => {
    process.env.SOURCE_ENCRYPTION_KEY = VALID_KEY;
    expect(isEncryptionConfigured()).toBe(true);
  });

  it("isEncryptionConfigured() → false cuando la key falta", () => {
    delete process.env.SOURCE_ENCRYPTION_KEY;
    expect(isEncryptionConfigured()).toBe(false);
  });

  it("encrypt() lanza error cuando SOURCE_ENCRYPTION_KEY falta", () => {
    delete process.env.SOURCE_ENCRYPTION_KEY;
    expect(() => encrypt("test")).toThrow(/SOURCE_ENCRYPTION_KEY/);
  });

  it("decrypt() lanza error cuando SOURCE_ENCRYPTION_KEY falta", () => {
    process.env.SOURCE_ENCRYPTION_KEY = VALID_KEY;
    const ciphertext = encrypt("test");
    delete process.env.SOURCE_ENCRYPTION_KEY;
    expect(() => decrypt(ciphertext)).toThrow(/SOURCE_ENCRYPTION_KEY/);
  });

  it("clave diferente → decrypt falla (auth tag)", () => {
    process.env.SOURCE_ENCRYPTION_KEY = VALID_KEY;
    const ciphertext = encrypt("secret");
    process.env.SOURCE_ENCRYPTION_KEY = "different-key-of-exactly-32-chars-here";
    expect(() => decrypt(ciphertext)).toThrow();
  });
});
