/**
 * M21.8 — fail-closed del pool background (`bg_role`).
 *
 * El pool background es LAZY y NUNCA hace fallback a `DATABASE_URL`: si
 * `BG_DATABASE_URL` falta, `bgDb()` lanza al primer uso por un flujo background
 * (scanner/scheduler/recovery), mientras que el HTTP (app_role) puede seguir
 * funcionando sin la variable (no la toca).
 */
import { afterEach, describe, expect, it } from "vitest";

import { bgDb } from "@workspace/db/background";

const BG = "BG_DATABASE_URL";

describe("background db (bg_role) — fail-closed", () => {
  const originalBg = process.env[BG];
  const originalDb = process.env.DATABASE_URL;

  afterEach(() => {
    if (originalBg === undefined) delete process.env[BG];
    else process.env[BG] = originalBg;
    if (originalDb === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = originalDb;
  });

  it("lanza si BG_DATABASE_URL falta, aunque DATABASE_URL esté definida (sin fallback)", () => {
    delete process.env[BG];
    process.env.DATABASE_URL = "postgresql://app_role:secret@db:5432/privacy";
    expect(() => bgDb()).toThrow(/BG_DATABASE_URL/);
  });

  it("lanza si BG_DATABASE_URL falta (sin ninguna variable de BD)", () => {
    delete process.env[BG];
    delete process.env.DATABASE_URL;
    expect(() => bgDb()).toThrow(/BG_DATABASE_URL/);
  });
});
