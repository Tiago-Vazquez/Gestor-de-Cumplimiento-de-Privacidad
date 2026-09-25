import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * M22 (P0-1) — las contraseñas de rol dejan de estar hardcodeadas.
 *
 * Convención del repo: sin arnés contra PostgreSQL real; se leen los artefactos
 * reales (migración SQL, docker-compose, .env.example y scripts de
 * provisioning) y se verifican los invariantes de seguridad.
 *
 * La migración 0018 (histórica, ya aplicada) sigue conteniendo las contraseñas
 * dev-only, pero 0019 las INVALIDA (`PASSWORD NULL`) y el provisioning real se
 * hace en runtime desde variables de entorno. Por eso el contrato de seguridad
 * se evalúa sobre 0019 + fuentes de configuración activas (compose, .env.example,
 * scripts), no sobre la migración histórica.
 */
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
const dbDir = resolve(repoRoot, "lib/db");

const journal = JSON.parse(
  readFileSync(resolve(dbDir, "drizzle/meta/_journal.json"), "utf8"),
) as { entries: { idx: number; tag: string }[] };

const m219 = journal.entries.find((entry) => entry.tag.startsWith("0019_"))!;
const m219Sql = readFileSync(resolve(dbDir, "drizzle", `${m219.tag}.sql`), "utf8");

const compose = readFileSync(resolve(repoRoot, "docker-compose.yml"), "utf8");
const envExample = readFileSync(resolve(repoRoot, ".env.example"), "utf8");
const provisionRoles = readFileSync(resolve(dbDir, "src/provision-roles.ts"), "utf8");
const provisionAdmin = readFileSync(resolve(dbDir, "src/provision-admin.ts"), "utf8");

describe("M22 (P0-1) — roles sin credenciales hardcodeadas", () => {
  it("el journal registra 0019", () => {
    expect(m219.idx).toBe(19);
    expect(m219.tag).toMatch(/^0019_/);
  });

  it("0019 re-afirma app_role como NOSUPERUSER/NOBYPASSRLS", () => {
    expect(m219Sql).toContain(
      "ALTER ROLE app_role NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS",
    );
  });

  it("0019 re-afirma bg_role como NOSUPERUSER/BYPASSRLS", () => {
    expect(m219Sql).toContain(
      "ALTER ROLE bg_role NOSUPERUSER NOCREATEDB NOCREATEROLE BYPASSRLS",
    );
  });

  it("0019 neutraliza las contraseñas dev-only (PASSWORD NULL, fail-closed)", () => {
    expect(m219Sql).toContain("ALTER ROLE app_role PASSWORD NULL");
    expect(m219Sql).toContain("ALTER ROLE bg_role PASSWORD NULL");
  });

  it("0019 no fija ninguna contraseña literal (solo PASSWORD NULL)", () => {
    // No debe existir ningún `PASSWORD '...'` literal; solo `PASSWORD NULL`.
    expect(m219Sql).not.toMatch(/PASSWORD\s+'/);
  });

  it("docker-compose.yml no contiene contraseñas hardcodeadas", () => {
    expect(compose).not.toContain("app-role-dev-only");
    expect(compose).not.toContain("bg-role-dev-only");
    expect(compose).not.toContain("privacy-dev-only");
  });

  it(".env.example no contiene valores dev hardcodeados", () => {
    expect(envExample).not.toContain("app-role-dev-only");
    expect(envExample).not.toContain("bg-role-dev-only");
    expect(envExample).not.toContain("privacy-dev-only");
  });

  it("provision-roles.ts lee las contraseñas del entorno (sin literales)", () => {
    expect(provisionRoles).toContain("APP_ROLE_PASSWORD");
    expect(provisionRoles).toContain("BG_ROLE_PASSWORD");
    expect(provisionRoles).toContain("ADMIN_DATABASE_URL");
    expect(provisionRoles).not.toContain("app-role-dev-only");
    expect(provisionRoles).not.toContain("bg-role-dev-only");
  });

  it("provision-admin.ts usa superusuario (ADMIN_DATABASE_URL) y genera identidad no fija", () => {
    expect(provisionAdmin).toContain("ADMIN_DATABASE_URL");
    expect(provisionAdmin).toContain("PROVISION_ADMIN_EMAIL");
    expect(provisionAdmin).toContain("PROVISION_ADMIN_PASSWORD");
    // El sub del admin NO es una constante fija: se genera aleatoriamente (o se
    // reutiliza por email), sin identidad privilegiada estática.
    expect(provisionAdmin).toContain("randomUUID");
  });
});
