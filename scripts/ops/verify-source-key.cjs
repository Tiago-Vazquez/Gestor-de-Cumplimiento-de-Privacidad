#!/usr/bin/env node
/**
 * M25.3 - Verificacion de SOURCE_ENCRYPTION_KEY sobre una base restaurada.
 *
 * El restore de M24 validaba checksums, conteos, RLS y atributos de roles, pero
 * NUNCA descifraba: solo comprobaba que la clave tuviese al menos 32 caracteres.
 * Un restore hecho con la clave equivocada pasaba todos esos criterios y aun asi
 * dejaba todas las fuentes sin conectar. Este script cierra ese hueco.
 *
 *   1. compara el fingerprint de la clave usada con el del manifest (si existe);
 *   2. descifra de verdad una connection_config contra la base restaurada.
 *
 * AES-256-GCM es autenticado: descifrar correctamente ES la prueba de que la
 * clave es la correcta. No se imprime plaintext, ciphertext ni campos de config.
 *
 * El algoritmo esta replicado porque ninguna imagen del stack incluye
 * artifacts/api-server/src/lib/secret-manager.ts (ver analisis M25.3). El formato
 * de ciphertext NO se modifica. El test de anclaje
 * artifacts/api-server/src/__tests__/restore-key-check-anchor.test.ts falla si
 * esta implementacion deja de coincidir con decrypt() real.
 *
 * Uso: dentro del contenedor `migrate`, con cwd=/repo/lib/db (donde pg resuelve).
 * Requiere ADMIN_DATABASE_URL y SOURCE_ENCRYPTION_KEY.
 */
const crypto = require("node:crypto");

const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 12;
const TAG_LENGTH = 16;
const ENCODING = "base64";

const EXIT_VERIFIED = 0;
const EXIT_FINGERPRINT_MISMATCH = 3;
const EXIT_DECRYPT_FAILED = 4;
const EXIT_NOT_VERIFIABLE = 5;
const EXIT_CHECK_ERROR = 6;

/** Clave derivada: sha256 del secreto. Debe coincidir con secret-manager.ts. */
function deriveKey(raw) {
  return crypto.createHash("sha256").update(raw).digest();
}

/** Huella de la clave derivada. Compara sin exponer el secreto. */
function keyFingerprint(raw) {
  return crypto.createHash("sha256").update(deriveKey(raw)).digest("hex");
}

/** Descifra iv:tag:ciphertext. Lanza si el tag no valida (clave incorrecta). */
function decryptBlob(ciphertext, raw) {
  const parts = String(ciphertext).split(":");
  if (parts.length !== 3) {
    throw new Error("Invalid ciphertext format");
  }
  const iv = Buffer.from(parts[0], ENCODING);
  const tag = Buffer.from(parts[1], ENCODING);
  const data = Buffer.from(parts[2], ENCODING);
  if (iv.length !== IV_LENGTH || tag.length !== TAG_LENGTH) {
    throw new Error("Invalid ciphertext: IV or tag length mismatch");
  }
  const decipher = crypto.createDecipheriv(ALGORITHM, deriveKey(raw), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(data), decipher.final()]).toString("utf8");
}

module.exports = { deriveKey, keyFingerprint, decryptBlob, ALGORITHM, IV_LENGTH, TAG_LENGTH };

async function main() {
  const raw = process.env.SOURCE_ENCRYPTION_KEY;
  if (!raw || raw.length < 32) {
    process.stderr.write("key-check: SOURCE_ENCRYPTION_KEY missing or too short\n");
    return EXIT_CHECK_ERROR;
  }
  const expected = (process.env.EXPECTED_KEY_FINGERPRINT || "").trim();
  const computed = keyFingerprint(raw);
  const dbUrl = process.env.ADMIN_DATABASE_URL;
  if (!dbUrl) {
    process.stderr.write("key-check: ADMIN_DATABASE_URL missing\n");
    return EXIT_CHECK_ERROR;
  }

  if (expected && expected !== computed) {
    process.stderr.write(
      "key-check: fingerprint mismatch (manifest=" + expected + ", provided=" + computed + ")\n",
    );
    return EXIT_FINGERPRINT_MISMATCH;
  }
  const fpState = expected ? "match" : "absent";

  const { Client } = require("pg");
  const client = new Client({ connectionString: dbUrl });
  let total = 0;
  let encrypted = 0;
  let blob = null;
  try {
    await client.connect();
    const counts = await client.query(
      "SELECT count(*)::int AS total, count(connection_config)::int AS encrypted FROM sources",
    );
    total = counts.rows[0].total;
    encrypted = counts.rows[0].encrypted;
    if (encrypted > 0) {
      const r = await client.query(
        "SELECT connection_config FROM sources WHERE connection_config IS NOT NULL LIMIT 1",
      );
      blob = r.rows[0].connection_config;
    }
  } catch (error) {
    process.stderr.write("key-check: could not read sources: " + error.message + "\n");
    return EXIT_CHECK_ERROR;
  } finally {
    await client.end().catch(() => {});
  }

  process.stdout.write("key_check_total_sources=" + total + "\n");
  process.stdout.write("key_check_encrypted_sources=" + encrypted + "\n");
  process.stdout.write("key_check_null_sources=" + (total - encrypted) + "\n");
  process.stdout.write("key_check_fingerprint=" + fpState + "\n");

  if (encrypted === 0) {
    process.stdout.write("key_check_verified=false\n");
    process.stdout.write("key_check_reason=no_encrypted_sources\n");
    return EXIT_NOT_VERIFIABLE;
  }

  try {
    JSON.parse(decryptBlob(blob, raw));
  } catch (error) {
    process.stderr.write("key-check: decryption failed: " + error.message + "\n");
    process.stdout.write("key_check_verified=false\n");
    process.stdout.write("key_check_reason=decryption_failed\n");
    return EXIT_DECRYPT_FAILED;
  }

  process.stdout.write("key_check_verified=true\n");
  return EXIT_VERIFIED;
}

if (require.main === module) {
  main()
    .then(function (code) {
      process.exit(code);
    })
    .catch(function (error) {
      process.stderr.write("key-check: unexpected error: " + error.message + "\n");
      process.exit(EXIT_CHECK_ERROR);
    });
}