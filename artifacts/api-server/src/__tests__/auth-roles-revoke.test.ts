import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import request from "supertest";
import type { Express } from "express";
import { decodeJwt, SignJWT } from "jose";
import { randomUUID } from "node:crypto";
import { TextEncoder } from "node:util";
import app from "../app";
import type { MockState } from "./mock-repos";

process.env.AUTH_DISABLED = "false";
process.env.JWT_SECRET = "test-secret-of-at-least-32-characters!!";
process.env.AUTH_BOOTSTRAP_TOKEN = "bootstrap-token-for-tests-only";
process.env.AUTH_BOOTSTRAP_ENABLED = "true"; // 6.3B.15: bootstrap opt-in (ausente = off)

const mocks = vi.hoisted(() => ({
  state: undefined as MockState | undefined,
  repos: undefined as unknown,
}));

vi.mock("@workspace/db", () => ({ pool: { query: vi.fn(), end: vi.fn() } }));
vi.mock("../repositories", async () => {
  const { createMockRepos } = await import("./mock-repos");
  const created = createMockRepos();
  mocks.state = created.state;
  mocks.repos = created.repos;
  return { repos: created.repos };
});

function state(): MockState {
  if (!mocks.state) throw new Error("mock repos not initialized");
  return mocks.state;
}

function extractJwt(setCookie: string | string[] | undefined): string {
  const cookies = Array.isArray(setCookie) ? setCookie : [setCookie];
  const match = cookies.join(",").match(/session=([^;]+)/);
  if (!match) throw new Error("session cookie not found");
  return match[1];
}

const secret = () => new TextEncoder().encode(process.env.JWT_SECRET!);

/**
 * Crea una sesiÃ³n de worker "de verdad" SIN pasar por /login (evita el rate
 * limiter de 5 logins locales/15 min): firma un JWT con el secreto de tests y
 * crea su fila en el allowlist simulando exactamente lo que harÃ­a el login.
 * `jti` se genera como UUID (igual que signToken).
 */
async function workerSession(
  sub: string,
  roles: string[],
  opts: { jti?: string } = {},
): Promise<{ jwt: string; jti: string }> {
  const jti = opts.jti ?? randomUUID();
  const expiresIn = 8 * 60 * 60;
  const jwt = await new SignJWT({ email: null, name: null, roles, jti })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(sub)
    .setIssuedAt()
    .setIssuer("privacy-compliance-manager")
    .setAudience("privacy-compliance-manager")
    .setJti(jti)
    .setExpirationTime(`${expiresIn}s`)
    .sign(secret());

  if (!mocks.state) throw new Error("mock repos not initialized");
  mocks.state.sessions.push({
    jti,
    userSub: sub,
    issuedAt: new Date(),
    expiresAt: new Date(Date.now() + expiresIn * 1000),
    revokedAt: null,
  });
  return { jwt, jti };
}

async function bootstrapLogin(
  server: ReturnType<Express["listen"]>,
): Promise<{ jwt: string; jti: string; sub: string }> {
  const res = await request(server)
    .post("/api/auth/login")
    .send({ token: "bootstrap-token-for-tests-only" });
  expect(res.status).toBe(200);
  const jwt = extractJwt(res.headers["set-cookie"]);
  return { jwt, jti: decodeJwt(jwt).jti as string, sub: res.body.sub };
}
function sessionRow(jti: string) {
  return state().sessions.find((s) => s.jti === jti);
}

function rolesOf(sub: string): string[] {
  return state().userRoles
    .filter((r) => r.userSub === sub)
    .map((r) => r.role)
    .sort();
}

describe("Role change revokes active sessions (6.3B.5c)", () => {
  let server: ReturnType<Express["listen"]>;
  let admin: { jwt: string; jti: string; sub: string };
  let workerSub: string;

  beforeAll(async () => {
    server = app.listen(0);

    // Admin: bootstrap legacy (login NO rate-limitado).
    admin = await bootstrapLogin(server);

    // Worker local auditor (register no exige login).
    const reg = await request(server)
      .post("/api/auth/register")
      .send({ email: "worker@example.com", password: "secure-password-123" });
    expect(reg.status).toBe(201);
    workerSub = reg.body.sub;

    // Promover worker a admin (bootstrap admin; revoca la sesiÃ³n del worker).
    const promote = await request(server)
      .patch(`/api/users/${workerSub}/roles`)
      .set("Authorization", `Bearer ${admin.jwt}`)
      .send({ roles: ["admin"] });
    expect(promote.status).toBe(200);
    expect(rolesOf(workerSub)).toEqual(["admin"]);
  });

  afterAll(() => {
    server.close();
  });

  it("1. admin -> auditor: success, active sessions revoked, old JWT -> 401", async () => {
    // Worker admin con sesiÃ³n activa (auto-firmada + fila en allowlist).
    const w = await workerSession(workerSub, ["admin"]);
    expect(sessionRow(w.jti)?.revokedAt).toBeNull();

    const res = await request(server)
      .patch(`/api/users/${workerSub}/roles`)
      .set("Authorization", `Bearer ${admin.jwt}`)
      .send({ roles: ["auditor"] });
    expect(res.status).toBe(200);
    expect(res.body.roles).toEqual(["auditor"]);
    expect(rolesOf(workerSub)).toEqual(["auditor"]);

    expect(sessionRow(w.jti)?.revokedAt).not.toBeNull();
    const me = await request(server)
      .get("/api/auth/me")
      .set("Authorization", `Bearer ${w.jwt}`);
    expect(me.status).toBe(401);
  });

  it("2. auditor -> admin: revokes old session, old JWT 401, new login has admin", async () => {
    // Worker es auditor tras el test 1; sesiÃ³n activa auto-firmada.
    const w = await workerSession(workerSub, ["auditor"]);
    expect(rolesOf(workerSub)).toEqual(["auditor"]);

    const res = await request(server)
      .patch(`/api/users/${workerSub}/roles`)
      .set("Authorization", `Bearer ${admin.jwt}`)
      .send({ roles: ["admin"] });
    expect(res.status).toBe(200);
    expect(res.body.roles).toEqual(["admin"]);
    expect(rolesOf(workerSub)).toEqual(["admin"]);

    expect(sessionRow(w.jti)?.revokedAt).not.toBeNull();
    const me = await request(server)
      .get("/api/auth/me")
      .set("Authorization", `Bearer ${w.jwt}`);
    expect(me.status).toBe(401);

    // Nuevo login real (Ãºnico login local del archivo) obtiene admin.
    const realLogin = await request(server)
      .post("/api/auth/login")
      .send({ email: "worker@example.com", password: "secure-password-123" });
    expect(realLogin.status).toBe(200);
    const realJwt = extractJwt(realLogin.headers["set-cookie"]);
    const users = await request(server)
      .get("/api/users")
      .set("Authorization", `Bearer ${realJwt}`);
    expect(users.status).toBe(200);
  });

  it("3. self-demotion: admin can drop admin (another admin exists) and own JWT is revoked", async () => {
    // Tras el test 2 hay 2 admins: bootstrap admin y worker. Bootstrap se degrada
    // Ã©l mismo (worker sigue siendo admin â†’ permitido).
    const res = await request(server)
      .patch(`/api/users/${admin.sub}/roles`)
      .set("Authorization", `Bearer ${admin.jwt}`)
      .send({ roles: ["auditor"] });
    expect(res.status).toBe(200);
    expect(res.body.roles).toEqual(["auditor"]);
    expect(sessionRow(admin.jti)?.revokedAt).not.toBeNull();

    const me = await request(server)
      .get("/api/auth/me")
      .set("Authorization", `Bearer ${admin.jwt}`);
    expect(me.status).toBe(401);
  });

  it("4. last admin: cannot drop the only admin; roles unchanged, sessions NOT revoked", async () => {
    // Tras el test 3, worker es el ÃšNICO admin. Worker intenta degradarse â†’ 403.
    const w = await workerSession(workerSub, ["admin"]);
    expect(sessionRow(w.jti)?.revokedAt).toBeNull();

    const res = await request(server)
      .patch(`/api/users/${workerSub}/roles`)
      .set("Authorization", `Bearer ${w.jwt}`)
      .send({ roles: ["auditor"] });
    expect(res.status).toBe(403);
    expect(rolesOf(workerSub)).toEqual(["admin"]);
    expect(sessionRow(w.jti)?.revokedAt).toBeNull();
  });

  it("5. multiple sessions: role change revokes ALL active sessions", async () => {
    const boot = await bootstrapLogin(server); // re-arma rol admin del bootstrap
    const s1 = await workerSession(workerSub, ["admin"]);
    const s2 = await workerSession(workerSub, ["admin"]);
    const s3 = await workerSession(workerSub, ["admin"]);
    expect(sessionRow(s1.jti)?.revokedAt).toBeNull();
    expect(sessionRow(s2.jti)?.revokedAt).toBeNull();
    expect(sessionRow(s3.jti)?.revokedAt).toBeNull();

    const res = await request(server)
      .patch(`/api/users/${workerSub}/roles`)
      .set("Authorization", `Bearer ${boot.jwt}`)
      .send({ roles: ["auditor"] });
    expect(res.status).toBe(200);
    expect(rolesOf(workerSub)).toEqual(["auditor"]);

    expect(sessionRow(s1.jti)?.revokedAt).not.toBeNull();
    expect(sessionRow(s2.jti)?.revokedAt).not.toBeNull();
    expect(sessionRow(s3.jti)?.revokedAt).not.toBeNull();
    const me = await request(server)
      .get("/api/auth/me")
      .set("Authorization", `Bearer ${s2.jwt}`);
    expect(me.status).toBe(401);
  });

  it("6. identical roles: no revocation, regardless of array order", async () => {
    // Worker es auditor tras el test 5. Bootstrap (admin) lo sube a admin+auditor
    // (cambio efectivo â†’ revoca la sesiÃ³n del worker que estÃ© activa).
    const boot = await bootstrapLogin(server);
    const s0 = await workerSession(workerSub, ["auditor"]);
    await request(server)
      .patch(`/api/users/${workerSub}/roles`)
      .set("Authorization", `Bearer ${boot.jwt}`)
      .send({ roles: ["admin", "auditor"] });
    expect(rolesOf(workerSub)).toEqual(["admin", "auditor"]);
    expect(sessionRow(s0.jti)?.revokedAt).not.toBeNull();

    const s = await workerSession(workerSub, ["admin", "auditor"]);
    expect(sessionRow(s.jti)?.revokedAt).toBeNull();

    // Mismo conjunto, distinto orden â†’ SIN cambio efectivo â†’ NO revoca.
    const reordered = await request(server)
      .patch(`/api/users/${workerSub}/roles`)
      .set("Authorization", `Bearer ${s.jwt}`)
      .send({ roles: ["auditor", "admin"] });
    expect(reordered.status).toBe(200);
    expect(sessionRow(s.jti)?.revokedAt).toBeNull();

    // IdÃ©ntico otra vez (con duplicado tras normalizaciÃ³n) â†’ NO revoca.
    const dup = await request(server)
      .patch(`/api/users/${workerSub}/roles`)
      .set("Authorization", `Bearer ${s.jwt}`)
      .send({ roles: ["admin", "auditor", "admin"] });
    expect(dup.status).toBe(200);
    expect(sessionRow(s.jti)?.revokedAt).toBeNull();
  });

  it("7. revocation failure rolls back the role change too (atomic)", async () => {
    const s = await workerSession(workerSub, ["admin", "auditor"]);
    const jti = s.jti as string;
    const rolesBefore = rolesOf(workerSub);

    // Parchea el mÃ©todo transaccional combinado para que falle DESPUÃ‰S de
    // aplicar los roles (simula fallo de revocaciÃ³n dentro de la transacciÃ³n);
    // el mock replica el ROLLBACK restaurando roles y sesiones.
    const userRolesPatch = mocks.repos as unknown as {
      userRoles: {
        setRolesAndRevokeSessions: (sub: string, roles: string[]) => Promise<{ applied: string[]; changed: boolean; revokedSessions: number }>;
      };
    };
    const original = userRolesPatch.userRoles.setRolesAndRevokeSessions;
    userRolesPatch.userRoles.setRolesAndRevokeSessions = async (sub: string, target: string[]) => {
      const rolesSnapshot = state().userRoles
        .filter((r) => r.userSub === sub)
        .map((r) => ({ ...r }));
      const sessionsSnapshot = state().sessions
        .filter((r) => r.userSub === sub)
        .map((r) => ({ ...r }));
      try {
        state().userRoles = state().userRoles.filter((r) => r.userSub !== sub);
        for (const role of target) {
          state().userRoles.push({ userSub: sub, role, createdAt: new Date() });
        }
        throw new Error("simulated revocation failure");
      } catch (error) {
        state().userRoles = state().userRoles.filter((r) => r.userSub !== sub).concat(rolesSnapshot);
        state().sessions = state().sessions.filter((r) => r.userSub !== sub).concat(sessionsSnapshot);
        throw error;
      }
    };
    try {
      const res = await request(server)
        .patch(`/api/users/${workerSub}/roles`)
        .set("Authorization", `Bearer ${s.jwt}`)
        .send({ roles: ["auditor"] });
      expect(res.status).toBe(500);
    } finally {
      userRolesPatch.userRoles.setRolesAndRevokeSessions = original;
    }

    expect(rolesOf(workerSub)).toEqual(rolesBefore);
    expect(sessionRow(jti)?.revokedAt).toBeNull();
  });

  it("8. role update failure does NOT revoke sessions", async () => {
    const s = await workerSession(workerSub, ["admin", "auditor"]);
    const jti = s.jti as string;
    const rolesBefore = rolesOf(workerSub);

    const userRolesPatch = mocks.repos as unknown as {
      userRoles: {
        setRolesAndRevokeSessions: (sub: string, roles: string[]) => Promise<{ applied: string[]; changed: boolean; revokedSessions: number }>;
      };
    };
    const original = userRolesPatch.userRoles.setRolesAndRevokeSessions;
    userRolesPatch.userRoles.setRolesAndRevokeSessions = async () => {
      throw new Error("simulated role update failure");
    };
    try {
      const res = await request(server)
        .patch(`/api/users/${workerSub}/roles`)
        .set("Authorization", `Bearer ${s.jwt}`)
        .send({ roles: ["admin"] });
      expect(res.status).toBe(500);
    } finally {
      userRolesPatch.userRoles.setRolesAndRevokeSessions = original;
    }

    expect(rolesOf(workerSub)).toEqual(rolesBefore);
    expect(sessionRow(jti)?.revokedAt).toBeNull();
  });

  it("9. idempotency: equivalent second operation does not re-revoke or alter revoked_at", async () => {
    const s = await workerSession(workerSub, ["admin", "auditor"]);
    const jti = s.jti as string;
    expect(sessionRow(jti)?.revokedAt).toBeNull();

    // Cambio efectivo: admin+auditor â†’ auditor (revoca la sesiÃ³n s).
    const first = await request(server)
      .patch(`/api/users/${workerSub}/roles`)
      .set("Authorization", `Bearer ${s.jwt}`)
      .send({ roles: ["auditor"] });
    expect(first.status).toBe(200);
    expect(rolesOf(workerSub)).toEqual(["auditor"]);
    const firstRevokedAt = sessionRow(jti)?.revokedAt as Date;
    expect(firstRevokedAt).toBeInstanceOf(Date);

    // Segunda operaciÃ³n equivalente (mismos roles) hecha por otro admin:
    // sin cambio efectivo â†’ NO toca `revoked_at` de la sesiÃ³n ya revocada.
    const boot = await bootstrapLogin(server);
    const same = await request(server)
      .patch(`/api/users/${workerSub}/roles`)
      .set("Authorization", `Bearer ${boot.jwt}`)
      .send({ roles: ["auditor"] });
    expect(same.status).toBe(200);
    expect(sessionRow(jti)?.revokedAt).toBeInstanceOf(Date);
    expect((sessionRow(jti)?.revokedAt as Date).getTime()).toBe(firstRevokedAt.getTime());
  });
});