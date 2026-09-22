import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import request from "supertest";
import type { Express } from "express";
import app from "../app";
import type { MockState } from "./mock-repos";
import { fetchCsrfToken } from "./test-utils";

process.env.AUTH_DISABLED = "false";
process.env.JWT_SECRET = "test-secret-of-at-least-32-characters!!";
process.env.AUTH_BOOTSTRAP_TOKEN = "bootstrap-token-for-tests-only";
process.env.AUTH_BOOTSTRAP_ENABLED = "true"; // 6.3B.15: bootstrap opt-in
process.env.AUTH_REGISTRATION_ENABLED = "true";

// El factory de vi.mock corre durante la evaluación de imports (antes del body
// de este módulo); vi.hoisted evita el TDZ al asignarle desde el factory.
const mocks = vi.hoisted(() => ({ state: undefined as MockState | undefined }));

vi.mock("@workspace/db", () => ({ pool: { query: vi.fn(), end: vi.fn() } }));
vi.mock("../repositories", async () => {
  const { createMockRepos } = await import("./mock-repos");
  const created = createMockRepos();
  mocks.state = created.state;
  return { repos: created.repos };
});

function extractJwt(setCookie: string | string[] | undefined): string {
  const cookies = Array.isArray(setCookie) ? setCookie : [setCookie];
  const match = cookies.join(",").match(/session=([^;]+)/);
  if (!match) throw new Error("session cookie not found");
  return match[1];
}

const BOOTSTRAP_TOKEN = "bootstrap-token-for-tests-only";

/**
 * M21.2 — Organizaciones, membresías e invitaciones (ADR-002).
 *
 * Cadena AUTHENTICACIÓN → MEMBERSHIP → AUTORIZACIÓN: el contexto de
 * organización vive en la sesión (`active_org_id`) y se re-valida contra la
 * membership en cada request (fail-closed).
 */
describe("Organizations routes (M21.2)", () => {
  let server: ReturnType<Express["listen"]>;
  let ownerCookie: string;
  let ownerCsrf: string;
  let memberSub: string;
  let memberCookie: string;
  let memberCsrf: string;

  beforeAll(async () => {
    server = app.listen(0);

    // Owner: login bootstrap (crea org-bootstrap + membership owner, M21.2).
    const ownerLogin = await request(server)
      .post("/api/auth/login")
      .set("X-Forwarded-For", "10.21.0.1")
      .send({ token: BOOTSTRAP_TOKEN });
    expect(ownerLogin.status).toBe(200);
    ownerCookie = `session=${extractJwt(ownerLogin.headers["set-cookie"])}`;
    ownerCsrf = await fetchCsrfToken(server, ownerCookie);

    // Miembro invitado: registro + login local (sin organizaciones aún).
    const reg = await request(server).post("/api/auth/register").send({
      email: "invited@example.com",
      password: "secure-password-123",
      name: "Invited User",
    });
    expect(reg.status).toBe(201);
    memberSub = reg.body.sub;
    const memberLogin = await request(server)
      .post("/api/auth/login")
      .set("X-Forwarded-For", "10.21.0.2")
      .send({ email: "invited@example.com", password: "secure-password-123" });
    expect(memberLogin.status).toBe(200);
    memberCookie = `session=${extractJwt(memberLogin.headers["set-cookie"])}`;
    memberCsrf = await fetchCsrfToken(server, memberCookie);
  });

  afterAll(() => {
    server.close();
  });

  it("bootstrap admin gets owner context (org + role)", async () => {
    const list = await request(server).get("/api/orgs").set("Cookie", ownerCookie);
    expect(list.status).toBe(200);
    expect(list.body).toHaveLength(1);
    expect(list.body[0].organization.id).toBe("org-bootstrap");
    expect(list.body[0].role).toBe("owner");

    const current = await request(server)
      .get("/api/orgs/current")
      .set("Cookie", ownerCookie);
    expect(current.status).toBe(200);
    expect(current.body).toMatchObject({
      id: "org-bootstrap",
      slug: "bootstrap",
      role: "owner",
    });
  });

  it("user without organization has no org context (fail-closed)", async () => {
    const list = await request(server).get("/api/orgs").set("Cookie", memberCookie);
    expect(list.status).toBe(200);
    expect(list.body).toEqual([]);

    const current = await request(server)
      .get("/api/orgs/current")
      .set("Cookie", memberCookie);
    expect(current.status).toBe(403);
    expect(current.body.title).toBe("Forbidden");
  });

  it("member role cannot govern (role checks)", async () => {
    const denied = await request(server)
      .patch("/api/orgs/current/members/bootstrap-admin")
      .set("Cookie", memberCookie)
      .set("X-CSRF-Token", memberCsrf)
      .send({ role: "admin" });
    expect(denied.status).toBe(403);

    const invitations = await request(server)
      .get("/api/orgs/current/invitations")
      .set("Cookie", memberCookie);
    expect(invitations.status).toBe(403);

    const del = await request(server)
      .delete("/api/orgs/current/invitations/nope")
      .set("Cookie", memberCookie)
      .set("X-CSRF-Token", memberCsrf);
    expect(del.status).toBe(403);
  });

  it("member accepts the invitation and switches active org", async () => {
    const created = await request(server)
      .post("/api/orgs/current/invitations")
      .set("Cookie", ownerCookie)
      .set("X-CSRF-Token", ownerCsrf)
      .send({ email: "invited@example.com", role: "member" });
    expect(created.status).toBe(201);

    const accepted = await request(server)
      .post("/api/orgs/invitations/accept")
      .set("Cookie", memberCookie)
      .set("X-CSRF-Token", memberCsrf)
      .send({ token: created.body.token });
    expect(accepted.status).toBe(201);
    expect(accepted.body).toEqual({
      organizationId: "org-bootstrap",
      role: "member",
    });

    // La invitación es personal: reusar el token → 409 (ya aceptada).
    const reused = await request(server)
      .post("/api/orgs/invitations/accept")
      .set("Cookie", memberCookie)
      .set("X-CSRF-Token", memberCsrf)
      .send({ token: created.body.token });
    expect(reused.status).toBe(409);

    // El contexto de la sesión no cambia solo: el miembro fija su org activa.
    const currentBefore = await request(server)
      .get("/api/orgs/current")
      .set("Cookie", memberCookie);
    expect(currentBefore.status).toBe(403);

    const switched = await request(server)
      .post("/api/orgs/active")
      .set("Cookie", memberCookie)
      .set("X-CSRF-Token", memberCsrf)
      .send({ organizationId: "org-bootstrap" });
    expect(switched.status).toBe(200);
    expect(switched.body).toEqual({
      organizationId: "org-bootstrap",
      role: "member",
    });

    const current = await request(server)
      .get("/api/orgs/current")
      .set("Cookie", memberCookie);
    expect(current.status).toBe(200);
    expect(current.body.role).toBe("member");
  });

  it("invitation acceptance is personal (email mismatch -> 404)", async () => {
    const created = await request(server)
      .post("/api/orgs/current/invitations")
      .set("Cookie", ownerCookie)
      .set("X-CSRF-Token", ownerCsrf)
      .send({ email: "other@example.com", role: "auditor" });
    expect(created.status).toBe(201);

    // El miembro intenta aceptar una invitación dirigida a otro email.
    const wrongUser = await request(server)
      .post("/api/orgs/invitations/accept")
      .set("Cookie", memberCookie)
      .set("X-CSRF-Token", memberCsrf)
      .send({ token: created.body.token });
    expect(wrongUser.status).toBe(404);
  });

  it("expired invitation -> 410; revoked invitation -> 404", async () => {
    // Expirada: invitación PERSONAL para el miembro, con expiresAt vencido.
    // El check de vencimiento precede al de already_member en el consumo.
    const created = await request(server)
      .post("/api/orgs/current/invitations")
      .set("Cookie", ownerCookie)
      .set("X-CSRF-Token", ownerCsrf)
      .send({ email: "invited@example.com", role: "member" });
    expect(created.status).toBe(201);
    const stored = mocks.state!.invitations!.find(
      (row) => row.email === "invited@example.com" && row.acceptedAt === null,
    );
    expect(stored).toBeDefined();
    stored!.expiresAt = new Date(Date.now() - 1000);

    const expired = await request(server)
      .post("/api/orgs/invitations/accept")
      .set("Cookie", memberCookie)
      .set("X-CSRF-Token", memberCsrf)
      .send({ token: created.body.token });
    expect(expired.status).toBe(410);

    // Revocada: existe pero el owner la elimina antes de la aceptación.
    const toRevoke = await request(server)
      .post("/api/orgs/current/invitations")
      .set("Cookie", ownerCookie)
      .set("X-CSRF-Token", ownerCsrf)
      .send({ email: "revoke@example.com", role: "member" });
    const revoked = await request(server)
      .delete(`/api/orgs/current/invitations/${toRevoke.body.id}`)
      .set("Cookie", ownerCookie)
      .set("X-CSRF-Token", ownerCsrf);
    expect(revoked.status).toBe(200);

    const gone = await request(server)
      .post("/api/orgs/invitations/accept")
      .set("Cookie", memberCookie)
      .set("X-CSRF-Token", memberCsrf)
      .send({ token: toRevoke.body.token });
    expect(gone.status).toBe(404);
  });

  it("owner promotes the member to admin (sessions revoked)", async () => {
    const res = await request(server)
      .patch(`/api/orgs/current/members/${memberSub}`)
      .set("Cookie", ownerCookie)
      .set("X-CSRF-Token", ownerCsrf)
      .send({ role: "admin" });
    expect(res.status).toBe(200);
    expect(res.body.role).toBe("admin");
    expect(res.body.revokedSessions).toBeGreaterThanOrEqual(1);

    // La sesión antigua del miembro murió con el cambio de privilegios.
    const stale = await request(server).get("/api/orgs").set("Cookie", memberCookie);
    expect(stale.status).toBe(401);

    // Re-login: el contexto activo se fija con la primera membership.
    const relogin = await request(server)
      .post("/api/auth/login")
      .set("X-Forwarded-For", "10.21.0.2")
      .send({ email: "invited@example.com", password: "secure-password-123" });
    expect(relogin.status).toBe(200);
    memberCookie = `session=${extractJwt(relogin.headers["set-cookie"])}`;
    memberCsrf = await fetchCsrfToken(server, memberCookie);

    const current = await request(server)
      .get("/api/orgs/current")
      .set("Cookie", memberCookie);
    expect(current.status).toBe(200);
    expect(current.body.role).toBe("admin");
  });

  it("active org switching validates membership (403 on foreign org)", async () => {
    // Organización secundaria + membership 'auditor' para el miembro.
    mocks.state!.organizations!.push({
      id: "org-secondary",
      name: "Secondary Org",
      slug: "secondary",
      status: "active",
      createdAt: new Date(),
    });
    mocks.state!.memberships!.push({
      organizationId: "org-secondary",
      userSub: memberSub,
      role: "auditor",
      invitedBy: null,
      joinedAt: new Date(),
    });

    const switched = await request(server)
      .post("/api/orgs/active")
      .set("Cookie", memberCookie)
      .set("X-CSRF-Token", memberCsrf)
      .send({ organizationId: "org-secondary" });
    expect(switched.status).toBe(200);
    expect(switched.body.role).toBe("auditor");

    const current = await request(server)
      .get("/api/orgs/current")
      .set("Cookie", memberCookie);
    expect(current.status).toBe(200);
    expect(current.body.id).toBe("org-secondary");

    // Organización de la que NO es miembro → 403 (la autoridad es la BD).
    const foreign = await request(server)
      .post("/api/orgs/active")
      .set("Cookie", memberCookie)
      .set("X-CSRF-Token", memberCsrf)
      .send({ organizationId: "org-unknown" });
    expect(foreign.status).toBe(403);

    // Body inválido → 400.
    const invalid = await request(server)
      .post("/api/orgs/active")
      .set("Cookie", memberCookie)
      .set("X-CSRF-Token", memberCsrf)
      .send({});
    expect(invalid.status).toBe(400);
  });

  it("owner membership is immutable and member removal revokes access", async () => {
    // `owner` no es editable ni removible vía API en M21.2.
    const patchOwner = await request(server)
      .patch("/api/orgs/current/members/bootstrap-admin")
      .set("Cookie", ownerCookie)
      .set("X-CSRF-Token", ownerCsrf)
      .send({ role: "member" });
    expect(patchOwner.status).toBe(403);

    const deleteOwner = await request(server)
      .delete("/api/orgs/current/members/bootstrap-admin")
      .set("Cookie", ownerCookie)
      .set("X-CSRF-Token", ownerCsrf);
    expect(deleteOwner.status).toBe(403);

    // Baja del miembro admin: sesiones revocadas + contexto limpiado.
    const removed = await request(server)
      .delete(`/api/orgs/current/members/${memberSub}`)
      .set("Cookie", ownerCookie)
      .set("X-CSRF-Token", ownerCsrf);
    expect(removed.status).toBe(200);
    expect(removed.body.removed).toBe(true);
    expect(removed.body.revokedSessions).toBeGreaterThanOrEqual(1);

    const stale = await request(server).get("/api/orgs").set("Cookie", memberCookie);
    expect(stale.status).toBe(401);

    // Sin NINGUNA membership restante (se elimina también la de org-secondary
    // del test de switching): re-login → sin contexto de organización.
    const state = mocks.state!;
    state.memberships = state.memberships!.filter((m) => m.userSub !== memberSub);

    // Re-login: sin membership, sin contexto de organización.
    const relogin = await request(server)
      .post("/api/auth/login")
      .set("X-Forwarded-For", "10.21.0.3")
      .send({ email: "invited@example.com", password: "secure-password-123" });
    expect(relogin.status).toBe(200);
    const freshCookie = `session=${extractJwt(relogin.headers["set-cookie"])}`;
    const freshCsrf = await fetchCsrfToken(server, freshCookie);

    const current = await request(server)
      .get("/api/orgs/current")
      .set("Cookie", freshCookie);
    expect(current.status).toBe(403);

    const switchBack = await request(server)
      .post("/api/orgs/active")
      .set("Cookie", freshCookie)
      .set("X-CSRF-Token", freshCsrf)
      .send({ organizationId: "org-bootstrap" });
    expect(switchBack.status).toBe(403);
  });

  it("input validation on invitations", async () => {
    const badRole = await request(server)
      .post("/api/orgs/current/invitations")
      .set("Cookie", ownerCookie)
      .set("X-CSRF-Token", ownerCsrf)
      .send({ email: "x@example.com", role: "owner" });
    expect(badRole.status).toBe(400);

    const badEmail = await request(server)
      .post("/api/orgs/current/invitations")
      .set("Cookie", ownerCookie)
      .set("X-CSRF-Token", ownerCsrf)
      .send({ email: "not-an-email", role: "member" });
    expect(badEmail.status).toBe(400);

    const noToken = await request(server)
      .post("/api/orgs/invitations/accept")
      .set("Cookie", ownerCookie)
      .set("X-CSRF-Token", ownerCsrf)
      .send({});
    expect(noToken.status).toBe(400);

    const unknown = await request(server)
      .post("/api/orgs/invitations/accept")
      .set("Cookie", ownerCookie)
      .set("X-CSRF-Token", ownerCsrf)
      .send({ token: "totally-unknown-token-value-1234" });
    expect(unknown.status).toBe(404);
  });
});
