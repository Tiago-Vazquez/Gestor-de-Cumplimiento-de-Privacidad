import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import request from "supertest";
import type { Express } from "express";
import { decodeJwt } from "jose";
import app from "../app";
import { signToken } from "../auth/tokens";
import type { MockState } from "./mock-repos";

// Suite con autenticación REAL: activamos JWT para validar el middleware.
process.env.AUTH_DISABLED = "false";
process.env.JWT_SECRET = "test-secret-of-at-least-32-characters!!";

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

describe("Auth middleware (JWT)", () => {
  let server: ReturnType<Express["listen"]>;
  let adminToken: string;
  let auditorToken: string;

  beforeAll(async () => {
    server = app.listen(0);
    adminToken = await signToken({
      sub: "admin-1",
      email: "admin@test.local",
      name: "Admin",
      roles: ["admin"],
    });
    auditorToken = await signToken({
      sub: "auditor-1",
      email: "auditor@test.local",
      name: "Auditor",
      roles: ["auditor"],
    });
    // Cutover del allowlist: cada token con `jti` necesita una fila de sesión
    // activa para ser aceptado por requireAuth().
    for (const token of [adminToken, auditorToken]) {
      const { jti, sub, exp } = decodeJwt(token);
      state().sessions.push({
        jti: jti!,
        userSub: sub!,
        issuedAt: new Date(),
        expiresAt: new Date((exp ?? 0) * 1000),
        revokedAt: null,
      });
    }
  });

  afterAll(() => {
    server.close();
  });

  it("returns 401 + WWW-Authenticate when no token is provided", async () => {
    const res = await request(server).get("/api/dashboard");
    expect(res.status).toBe(401);
    expect(res.headers["www-authenticate"]).toContain("Bearer");
    expect(res.body.status).toBe(401);
  });

  it("returns 401 for an invalid token", async () => {
    const res = await request(server)
      .get("/api/dashboard")
      .set("Authorization", "Bearer not-a-valid-jwt");
    expect(res.status).toBe(401);
  });

  it("returns 200 for an auditor on a read endpoint", async () => {
    const res = await request(server)
      .get("/api/dashboard")
      .set("Authorization", `Bearer ${auditorToken}`);
    expect(res.status).toBe(200);
  });

  it("returns 403 for an auditor on an admin-only mutation", async () => {
    const res = await request(server)
      .post("/api/reports")
      .set("Authorization", `Bearer ${auditorToken}`)
      .send({ name: "x", period: "last_30d" });
    expect(res.status).toBe(403);
    expect(res.body.status).toBe(403);
  });

  it("returns 201 for an admin on an admin-only mutation", async () => {
    const res = await request(server)
      .post("/api/reports")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ name: "Admin Report", period: "last_30d" });
    expect(res.status).toBe(201);
  });

  it("keeps /api/healthz public without a token", async () => {
    const res = await request(server).get("/api/healthz");
    expect(res.status).toBe(200);
  });

  it("returns 401 for an expired JWT", async () => {
    const { signToken } = await import("../auth/tokens");
    const expiredToken = await signToken(
      {
        sub: "admin-1",
        email: "admin@test.local",
        name: "Admin",
        roles: ["admin"],
      },
      { expiresInSeconds: -1 }, // Ya expirado
    );

    const res = await request(server)
      .get("/api/dashboard")
      .set("Authorization", `Bearer ${expiredToken}`);
    expect(res.status).toBe(401);
    expect(res.headers["www-authenticate"]).toContain("Bearer");
  });

  it("returns 401 for a tampered JWT", async () => {
    // Token manipulado: alteramos la firma cambiando el último caracter
    const validToken = `Bearer ${adminToken}`;
    const tampered = validToken.slice(0, -1) + (validToken.slice(-1) === "A" ? "B" : "A");

    const res = await request(server)
      .get("/api/dashboard")
      .set("Authorization", tampered);
    expect(res.status).toBe(401);
    expect(res.headers["www-authenticate"]).toContain("Bearer");
  });

  it("returns 401 for a JWT without jti (legacy tokens rejected)", async () => {
    const { signToken } = await import("../auth/tokens");
    const tokenWithoutJti = await signToken({
      sub: "admin-1",
      email: "admin@test.local",
      name: "Admin",
      roles: ["admin"],
    });
    const parts = tokenWithoutJti.split(".");
    const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString());
    delete payload.jti;
    const encodedPayload = Buffer.from(JSON.stringify(payload)).toString("base64url");
    const legacyToken = `${parts[0]}.${encodedPayload}.${parts[2]}`;

    const res = await request(server)
      .get("/api/dashboard")
      .set("Authorization", `Bearer ${legacyToken}`);
    expect(res.status).toBe(401);
    expect(res.headers["www-authenticate"]).toContain("Bearer");
  });

  it("returns 401 for a JWT with jti but no session row", async () => {
    const { signToken } = await import("../auth/tokens");
    const token = await signToken({
      sub: "no-session-user",
      email: "nosession@test.local",
      name: "No Session",
      roles: ["admin"],
    });

    const res = await request(server)
      .get("/api/dashboard")
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(401);
    expect(res.headers["www-authenticate"]).toContain("Bearer");
  });
});