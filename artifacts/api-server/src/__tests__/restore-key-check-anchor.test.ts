import { describe, it, expect, afterEach } from "vitest";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { encrypt, decrypt } from "../lib/secret-manager";

/**
 * M25.3 — Test de anclaje del verificador de clave.
 *
 * `scripts/ops/verify-source-key.cjs` replica la derivación de clave y el
 * descifrado de `lib/secret-manager.ts`, porque ninguna imagen del stack de
 * restore incluye ese módulo. Esa replicación es un riesgo de divergencia: si
 * el algoritmo real cambia y el check inline no, el restore empezaría a dar
 * veredictos falsos.
 *
 * Estos tests son el ancla: fallan en cuanto las dos implementaciones dejan de
 * coincidir, en las dos direcciones.
 *
 * Si el anclaje un día rompe por un cambio legítimo en `secret-manager.ts`, la
 * corrección NO es relajar el test: es actualizar `verify-source-key.cjs` en el
 * mismo commit. El formato del ciphertext no se modifica.
 */

const requireCjs = createRequire(import.meta.url);
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
const checkPath = resolve(repoRoot, "scripts/ops/verify-source-key.cjs");
// eslint-disable-next-line @typescript-eslint/no-var-requires
const inline = requireCjs(checkPath) as {
  deriveKey: (raw: string) => Buffer;
  keyFingerprint: (raw: string) => string;
  decryptBlob: (ciphertext: string, raw: string) => string;
  ALGORITHM: string;
  IV_LENGTH: number;
  TAG_LENGTH: number;
};

const KEY = "test-source-encryption-key-of-32-chars!!";
const OTHER_KEY = "otra-clave-de-prueba-de-32-chars-minimo!!";

describe("M25.3 anclaje: verify-source-key.cjs vs secret-manager", () => {
  const originalKey = process.env.SOURCE_ENCRYPTION_KEY;

  afterEach(() => {
    if (originalKey === undefined) {
      delete process.env.SOURCE_ENCRYPTION_KEY;
    } else {
      process.env.SOURCE_ENCRYPTION_KEY = originalKey;
    }
  });

  it("declara las mismas constantes que secret-manager", () => {
    expect(inline.ALGORITHM).toBe("aes-256-gcm");
    expect(inline.IV_LENGTH).toBe(12);
    expect(inline.TAG_LENGTH).toBe(16);
  });

  it("deriva la clave igual que secret-manager", () => {
    process.env.SOURCE_ENCRYPTION_KEY = KEY;
    // secret-manager deriva internamente; comparamos el resultado observable.
    const viaInline = inline.deriveKey(KEY).toString("base64");
    // Derivación de referencia: sha256 del secreto.
    const reference = requireCjs("node:crypto")
      .createHash("sha256")
      .update(KEY)
      .digest("base64");
    expect(viaInline).toBe(reference);
    expect(inline.deriveKey(KEY).length).toBe(32);
  });

  it("descifra exactamente lo que descifra decrypt() real", () => {
    process.env.SOURCE_ENCRYPTION_KEY = KEY;
    const plaintext = JSON.stringify({ kind: "postgresql", host: "db.example", password: "p4ss" });
    const ciphertext = encrypt(plaintext);
    expect(inline.decryptBlob(ciphertext, KEY)).toBe(decrypt(ciphertext));
    expect(inline.decryptBlob(ciphertext, KEY)).toBe(plaintext);
  });

  it("falla con la clave equivocada, igual que decrypt()", () => {
    process.env.SOURCE_ENCRYPTION_KEY = KEY;
    const ciphertext = encrypt("secreto");
    expect(() => decrypt(ciphertext.replace(/:.*/, `:x:${ciphertext.split(":")[2]}`))).toThrow();
    // La clave que descifró correctamente debe ser rechazada por la otra.
    expect(() => inline.decryptBlob(ciphertext, OTHER_KEY)).toThrow();
  });

  it("rechaza formatos de ciphertext inválidos", () => {
    expect(() => inline.decryptBlob("sin-separadores", KEY)).toThrow(/format/i);
    expect(() => inline.decryptBlob("a:b:c", KEY)).toThrow(/IV or tag length/i);
  });

  it("el fingerprint es estable y no depende del texto plano", () => {
    expect(inline.keyFingerprint(KEY)).toBe(inline.keyFingerprint(KEY));
    expect(inline.keyFingerprint(KEY)).not.toBe(inline.keyFingerprint(OTHER_KEY));
    expect(inline.keyFingerprint(KEY)).toMatch(/^[0-9a-f]{64}$/);
    // El fingerprint no puede contener el secreto ni una porción derivable.
    expect(inline.keyFingerprint(KEY)).not.toContain(KEY);
  });
});
