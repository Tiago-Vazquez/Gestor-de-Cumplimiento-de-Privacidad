import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import request from "supertest";
import type { Express } from "express";
import app from "../app";
import type { MockState } from "./mock-repos";
import {
  seedProvisionedAdmin,
  TEST_ADMIN_EMAIL,
  TEST_ADMIN_PASSWORD,
  TEST_ADMIN_SUB,
} from "./test-utils";

/**
 * M22 (P0-2) — el bootstrap legacy quedó ELIMINADO.
 *
 * Demuestra que:
 * - `POST /auth/login` con `{ token }` ya NO concede acceso (no hay identidad
 *   privilegiada fija ni token estático): responde 400 sin crear sesión.
 * - No se materializa ninguna identidad `bootstrap-admin`.
 * - El primer administrador se provisiona (seedProvisionedAdmin) y loguea por
 *   el flujo normal email + password.
 */
process.env.AUTH_DISABLED = "false";
process.env.JWT_SECRET = "test-secret-of-at-least-32-characters!!";
process.env.AUTH_REGISTRATION_ENABLED = "true";
process.env.SOURCE_ENCRYPTION_KEY = "test-source-encryption-key-of-at-least-32-characters!!";

const mocks = vi.hoisted(() => ({ state: undefined as MockState | undefined }));

vi.mock("@workspace/db", () => ({ pool: { query: vi.fn(), end: vi.fn() } }));
vi.mock("../repositories", async () => {
  const { createMockRepos } = await import("./mock-repos");
  const created = createMockRepos();
  mocks.state = created.state;
  return { repos: created.repos };
});

function state(): MockState {
  if (!mocks.state) throw new Error("mock repos not initialized");
  return mocks.state;
}

describe("M22 P0-2 — bootstrap eliminado", () => {
  let server: ReturnType<Express["listen"]>;

  beforeAll(() => {
    server = app.listen(0);
  });

  afterAll(() => {
    server.close();
  });

  it("login con { token } ya no concede acceso (400, sin sesión)", async () => {
    const res = await request(server)
      .post("/api/auth/login")
      .send({ token: "any-static-token-value" });
    expect(res.status).toBe(400);
    expect(res.headers["set-cookie"]).toBeUndefined();
  });

  it("no se materializa ninguna identidad privilegiada fija", async () => {
    await request(server)
      .post("/api/auth/login")
      .send({ token: "any-static-token-value" });
    expect(state().users.some((u) => u.sub === "admin-provisioned")).toBe(false);
    expect(state().userRoles.length).toBe(0);
  });

  it("el primer administrador se provisiona y loguea por email + password", async () => {
    await seedProvisionedAdmin(state());
    const res = await request(server)
      .post("/api/auth/login")
      .send({ email: TEST_ADMIN_EMAIL, password: TEST_ADMIN_PASSWORD });
    expect(res.status).toBe(200);
    expect(res.body.sub).toBe(TEST_ADMIN_SUB);
    expect(res.body.roles).toEqual(["admin"]);
  });
});
