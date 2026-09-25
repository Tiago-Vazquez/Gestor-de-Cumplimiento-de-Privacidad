/**
 * M23.1 — Tests estructurales del aislamiento de la capa de conectores.
 *
 * Garantías por análisis de fuentes (sin motores reales):
 *  - Las rutas HTTP NO importan `connectors/` (ni directa ni transitivamente):
 *    el acceso a fuentes externas ocurre solo en flujos internos.
 *  - scanner y masking resuelven el conector por el registry (`getConnector`),
 *    NUNCA importan un motor concreto (`connectors/postgres`).
 *  - Los conectores no usan los pools de la plataforma (`db` / `bgDb`): solo
 *    el driver `pg` re-exportado, nunca la conexión aplicativa.
 */
import { readdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const srcDir = resolve(here, "..");
const routesDir = resolve(srcDir, "routes");
const connectorsDir = resolve(srcDir, "connectors");

const read = (dir: string, file: string) => readFileSync(resolve(dir, file), "utf8");
const ts = (dir: string) => readdirSync(dir).filter((f) => f.endsWith(".ts"));
const source = (relativePath: string) => readFileSync(resolve(srcDir, relativePath), "utf8");

describe("M23.1 — aislamiento de la capa de conectores", () => {
  it("ninguna ruta HTTP importa connectors/", () => {
    const files = ts(routesDir);
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      expect(read(routesDir, file), `routes/${file} no debe importar connectors/`).not.toContain(
        "connectors/",
      );
    }
  });

  it("scanner y masking usan el registry y no un motor concreto", () => {
    for (const file of ["services/scanner.ts", "repositories/masking.repo.ts"]) {
      const code = source(file);
      expect(code, `${file} debe resolver el conector por registry`).toContain(
        "connectors/registry",
      );
      expect(code, `${file} no debe importar connectors/postgres`).not.toContain(
        "connectors/postgres",
      );
      expect(code, `${file} no debe importar connectors/mysql`).not.toContain(
        "connectors/mysql",
      );
    }
  });

  it("el registry es el único punto que importa motores concretos", () => {
    const code = source("connectors/registry.ts");
    expect(code).toContain("./postgres");
    expect(code).toContain("./mysql");
  });

  it("los conectores no usan los pools de la plataforma (db/bgDb)", () => {
    const files = ts(connectorsDir);
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      const code = read(connectorsDir, file);
      expect(code, `connectors/${file} no debe usar bgDb`).not.toContain("bgDb");
      expect(code, `connectors/${file} no debe importar el pool background`).not.toContain(
        "@workspace/db/background",
      );
      // El único símbolo permitido de @workspace/db es el driver `pg`.
      const workspaceDbImports = code.match(/import\s*\{([^}]*)\}\s*from\s*"@workspace\/db"/g) ?? [];
      for (const statement of workspaceDbImports) {
        expect(statement.replace(/\s+/g, " "), `connectors/${file} solo puede importar pg`).toBe(
          'import { pg } from "@workspace/db"',
        );
      }
    }
  });

  it("el scanner no importa funciones de motor directamente (deuda M23.1 corregida)", () => {
    const code = source("services/scanner.ts");
    expect(code).not.toContain("connectPg");
    expect(code).not.toContain("quoteIdent");
    // El listado/lectura pasa SIEMPRE por el conector resuelto.
    expect(code).toContain("connector.listTables(");
    expect(code).toContain("connector.readPage(");
    expect(code).toContain("getConnector(");
  });
});
