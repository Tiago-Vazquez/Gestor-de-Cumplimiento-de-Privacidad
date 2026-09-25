import pg from "pg";

/**
 * M22 (P0-1) — Provisioning de contraseñas de los roles de aplicación.
 *
 * Fija las contraseñas de `app_role` (HTTP, NOBYPASSRLS) y `bg_role`
 * (background, BYPASSRLS) a partir de secretos del entorno. Se ejecuta como
 * paso de despliegue (después de las migraciones, antes del arranque de la
 * API) usando una conexión de superusuario (`ADMIN_DATABASE_URL` → `privacy`).
 *
 * - Ninguna contraseña queda hardcodeada en el repositorio: las migraciones
 *   (0019) dejan los roles con `PASSWORD NULL` y este script inyecta el valor
 *   real desde `APP_ROLE_PASSWORD` / `BG_ROLE_PASSWORD`.
 * - Fail-closed: si falta alguna variable, aborta (nunca deja una contraseña
 *   vacía ni usa un fallback).
 * - Idempotente: re-ejecutable (rotación = volver a correrlo con secretos nuevos).
 *
 * Seguridad de interpolación: `ALTER ROLE ... PASSWORD` es un utility
 * statement que NO admite parámetros vinculados, por lo que el valor se escapa
 * doblando comillas simples y rechazando bytes NUL. Se documenta explícitamente
 * para que ninguna edición futura lo reemplace por interpolación cruda.
 */

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value || value.trim() === "") {
    throw new Error(`${name} is required for role provisioning (fail-closed)`);
  }
  return value;
}

/** Escapa un literal SQL de forma segura (dobla comillas simples, rechaza NUL). */
function quoteLiteral(value: string): string {
  if (value.includes("\u0000")) {
    throw new Error("role password contains a NUL byte; refusing to interpolate");
  }
  return `'${value.replaceAll("'", "''")}'`;
}

async function main(): Promise<void> {
  const adminUrl = requireEnv("ADMIN_DATABASE_URL");
  const appPassword = requireEnv("APP_ROLE_PASSWORD");
  const bgPassword = requireEnv("BG_ROLE_PASSWORD");

  const client = new pg.Client({ connectionString: adminUrl });
  try {
    await client.connect();
    await client.query(`ALTER ROLE app_role PASSWORD ${quoteLiteral(appPassword)}`);
    await client.query(`ALTER ROLE bg_role PASSWORD ${quoteLiteral(bgPassword)}`);
    console.log("Provisioned app_role and bg_role passwords from environment.");
  } finally {
    await client.end().catch(() => undefined);
  }
}

main().catch((error) => {
  console.error("role provisioning failed:", error instanceof Error ? error.message : error);
  process.exit(1);
});
