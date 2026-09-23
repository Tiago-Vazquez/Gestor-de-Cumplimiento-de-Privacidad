import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import request from "supertest";
import type { Express } from "express";
import app from "../app";
import type { MockState } from "./mock-repos";
import { fetchCsrfToken } from "./test-utils";

/**
 * M21.7.2 — Reinos de autorización (ADR-003 D2, decisiones B+C).
 *
 * Matriz efectiva cubierta:
 *   - Plataforma (GET /api/users, PATCH /rules/:id): requirePlatformAdmin()
 *     (rol global admin, SIN contexto de organización).
 *   - Auditoría org (GET /api/audit-events): requireRole("admin") global +
 *     resolvedOrgContext (decisión B: NO migrada a requireOrgRole).
 *   - Negocio lectura (GET /api/dashboard): resolvedOrgContext.
 *   - Negocio mutación (POST /api/sources): requireRole("admin") global +
 *     resolvedOrgContext (decisión C: NO migrada a requireOrgRole).
 *
 * | Perfil                      | Plataforma | Audit org | Lectura | Mutación |
 * |-----------------------------|-----------:|----------:|--------:|---------:|
 * | Admin global, sin org       |        200 |       403 |     403 |      403 |
 * | Admin global, con org       |        200 |       200 |     200 |      200 |
 * | Admin org, sin global admin |        403 |       403 |     200 |      403 |
 * | Miembro/auditor org         |        403 |       403 |     200 |      403 |
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

function cookieOf(res: { headers: { [k: string]: unknown } }): string {
  const set = res.headers["set-cookie"] as string[] | string | undefined;
  const arr = Array.isArray(set) ? set : set ? [set] : [];
  const hit = arr.find((c) => c.startsWith("session="));
  if (!hit) throw new Error("session cookie not found");
  return hit.split(";")[0];
}

const PASSWORD = "secure-password-123";

describe("M21.7.2 — reinos de autorización", () => {
  let server: ReturnType<Express["listen"]>;
  const cookies: Record<string, string> = {};
  const csrf: Record<string, string> = {};

  beforeAll(async () => {
    server = app.listen(0);

    const emails: Record<string, string> = {
      globalAdminNoOrg: "realm-admin-no-org@example.com",
      globalAdminWithOrg: "realm-admin-org@example.com",
      orgAdminNoGlobal: "realm-org-admin@example.com",
      memberOrg: "realm-member@example.com",
    };
    const subs: Record<string, string> = {};
    for (const [key, email] of Object.entries(emails)) {
      const res = await request(server)
        .post("/api/auth/register")
        .send({ email, password: PASSWORD, name: key });
      expect(res.status, `register ${key}`).toBe(201);
      subs[key] = res.body.sub as string;
    }

    state().organizations = [
      { id: "org-a", name: "Org A", slug: "org-a", status: "active", createdAt: new Date() },
    ];
    state().memberships = [
      { organizationId: "org-a", userSub: subs.globalAdminWithOrg, role: "admin", invitedBy: null, joinedAt: new Date() },
      { organizationId: "org-a", userSub: subs.orgAdminNoGlobal, role: "admin", invitedBy: null, joinedAt: new Date() },
      { organizationId: "org-a", userSub: subs.memberOrg, role: "member", invitedBy: null, joinedAt: new Date() },
    ];
    // Roles GLOBALES (user_roles): solo los dos "admin global".
    state().userRoles.push({ userSub: subs.globalAdminNoOrg, role: "admin", createdAt: new Date() });
    state().userRoles.push({ userSub: subs.globalAdminWithOrg, role: "admin", createdAt: new Date() });

    for (const [key, email] of Object.entries(emails)) {
      const login = await request(server).post("/api/auth/login").send({ email, password: PASSWORD });
      expect(login.status, `login ${key}`).toBe(200);
      cookies[key] = cookieOf(login);
      csrf[key] = await fetchCsrfToken(server, cookies[key]);
    }
  });

  afterAll(() => server.close());

  const as = (profile: string) => ({ Cookie: cookies[profile], "X-CSRF-Token": csrf[profile] });
  const get = (profile: string, url: string) => request(server).get(url).set(as(profile));
  const post = (profile: string, url: string, body: object) =>
    request(server).post(url).set(as(profile)).send(body);
  const patch = (profile: string, url: string, body: object) =>
    request(server).patch(url).set(as(profile)).send(body);

  it("matriz: admin global SIN org", async () => {
    const p = "globalAdminNoOrg";
    expect((await get(p, "/api/users")).status).toBe(200);
    expect((await get(p, "/api/audit-events")).status).toBe(403);
    expect((await get(p, "/api/dashboard")).status).toBe(403);
    expect((await post(p, "/api/sources", { name: "src", kind: "postgresql", environment: "production" })).status).toBe(403);
  });

  it("matriz: admin global CON org", async () => {
    const p = "globalAdminWithOrg";
    expect((await get(p, "/api/users")).status).toBe(200);
    expect((await get(p, "/api/audit-events")).status).toBe(200);
    expect((await get(p, "/api/dashboard")).status).toBe(200);
    expect((await post(p, "/api/sources", { name: "src", kind: "postgresql", environment: "production" })).status).toBe(201);
  });

  it("matriz: admin de org SIN rol global", async () => {
    const p = "orgAdminNoGlobal";
    expect((await get(p, "/api/users")).status).toBe(403);
    expect((await get(p, "/api/audit-events")).status).toBe(403);
    expect((await get(p, "/api/dashboard")).status).toBe(200);
    expect((await post(p, "/api/sources", { name: "src", kind: "postgresql", environment: "production" })).status).toBe(403);
  });

  it("matriz: miembro de org", async () => {
    const p = "memberOrg";
    expect((await get(p, "/api/users")).status).toBe(403);
    expect((await get(p, "/api/audit-events")).status).toBe(403);
    expect((await get(p, "/api/dashboard")).status).toBe(200);
    expect((await post(p, "/api/sources", { name: "src", kind: "postgresql", environment: "production" })).status).toBe(403);
  });

  it("mutación de reglas globales (superficie plataforma)", async () => {
    const body = { enabled: false };
    expect((await patch("globalAdminNoOrg", "/api/rules/rule-001", body)).status).toBe(200);
    expect((await patch("globalAdminWithOrg", "/api/rules/rule-001", body)).status).toBe(200);
    expect((await patch("orgAdminNoGlobal", "/api/rules/rule-001", body)).status).toBe(403);
    expect((await patch("memberOrg", "/api/rules/rule-001", body)).status).toBe(403);
  });

  it("crítico: admin global sin membership no obtiene contexto de organización", async () => {
    const p = "globalAdminNoOrg";
    // Accede a plataforma (admin legítimo)...
    expect((await get(p, "/api/users")).status).toBe(200);
    // ...pero no a datos de negocio (resolvedOrgContext falla cerrado: 403).
    expect((await get(p, "/api/dashboard")).status).toBe(403);
    // Y NO se le inventó una membership de organización.
    const sub = state().users.find((u) => u.email === "realm-admin-no-org@example.com")?.sub;
    expect((state().memberships ?? []).some((m) => m.userSub === sub)).toBe(false);
  });
});
