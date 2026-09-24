/**
 * M21.8 — aislamiento del pool background (`bg_role`).
 *
 * Garantías estructurales (análisis de fuentes, sin PostgreSQL real):
 *  - Ninguna ruta HTTP importa `@workspace/db/background`.
 *  - Solo los repos trusted (scans / sources / scan-schedules) importan el
 *    pool background; los repos tenant-scoped y de identidad siguen con `db`.
 */
import { readdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const BG = "@workspace/db/background";

const here = dirname(fileURLToPath(import.meta.url));
const routesDir = resolve(here, "../routes");
const reposDir = resolve(here, "../repositories");

const ts = (dir: string) => readdirSync(dir).filter((f) => f.endsWith(".ts"));
const read = (dir: string, f: string) => readFileSync(resolve(dir, f), "utf8");

describe("M21.8 — aislamiento del pool background (bg_role)", () => {
  it("ninguna ruta HTTP importa el pool background", () => {
    const files = ts(routesDir);
    expect(files.length).toBeGreaterThan(0);
    for (const f of files) {
      expect(read(routesDir, f), `routes/${f} no debe importar ${BG}`).not.toContain(BG);
    }
  });

  it("solo los repos trusted importan el pool background", () => {
    const trusted = ["scans.repo.ts", "sources.repo.ts", "scan-schedules.repo.ts"];
    const files = ts(reposDir);
    for (const f of files) {
      const src = read(reposDir, f);
      if (trusted.includes(f)) {
        expect(src, `repositories/${f} debe usar el pool background`).toContain(BG);
      } else {
        expect(src, `repositories/${f} no debe importar el pool background`).not.toContain(BG);
      }
    }
  });
});
