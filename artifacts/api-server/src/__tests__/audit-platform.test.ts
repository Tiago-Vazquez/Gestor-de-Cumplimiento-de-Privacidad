import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import request from "supertest";
import type { Express } from "express";
import type { Request } from "express";
import app from "../app";
import type { MockState } from "./mock-repos";
import { fetchCsrfToken } from "./test-utils";
import { recordAuditEvent, PLATFORM_ACTIONS } from "../lib/audit";

/**
 * M21.7.3 — Auditoría de plataforma (M3, ADR-003).
 *
 * Cubre:
 *  - El vocabulario cerrado PLATFORM_ACTIONS y su precedencia sobre
 *    resolveAuditTenant (escriben tenant_id = NULL aunque exista orgContext).
 *  - La paridad con el backfill 0016 (mismas 4 acciones NULL).
 *  - GET /api/audit-events/platform (reino plataforma, sin resolvedOrgContext).
 *  - GET /api/audit-events (reino organización, org-scoped).
 *  - La separación disjunta platform / org-a / org-b.
 */

process.env.AUTH_DISABLED = "false";
process.env.JWT_SECRET = "test-secret-of-at-least-32-characters!!";
process.env.AUTH_REGISTRATION_ENABLED = "true";

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

describe("M21.7.3 — PLATFORM_ACTIONS y recordAuditEvent (escritura)", () => {
  it("PLATFORM_ACTIONS contiene exactamente las 4 acciones de plataforma", () => {
    expect([...PLATFORM_ACTIONS].sort()).toEqual(
      ["rule_disabled", "rule_enabled", "security_violation", "user_roles_updated"].sort(),
    );
  });

  it("paridad con 0016: el backfill deja esas 4 acciones como NULL", () => {
    const sql = readFileSync(
      resolve(dirname(fileURLToPath(import.meta.url)), "../../../../lib/db/drizzle/0016_backfill_tenant.sql"),
      "utf8",
    );
    expect(sql).toContain("'rule_enabled','rule_disabled','user_roles_updated','security_violation'");
  });

  it("acciones de plataforma → tenant_id NULL aunque exista req.orgContext", async () => {
    const req = {
      user: { sub: "admin-sub", roles: ["admin"] },
      orgContext: { organizationId: "org-a", role: "owner" },
    } as unknown as Request;

    for (const action of [...PLATFORM_ACTIONS]) {
      await recordAuditEvent({ req, action, resourceType: "user", resourceId: "r", result: "success" });
      expect(state().auditEvents[0].action).toBe(action);
      expect(state().auditEvents[0].tenantId).toBeNull();
    }
  });

  it("acción NO de plataforma conserva el tenant de la organización activa", async () => {
    const req = {
      user: { sub: "admin-sub", roles: ["admin"] },
      orgContext: { organizationId: "org-a", role: "owner" },
    } as unknown as Request;

    await recordAuditEvent({ req, action: "user_updated", resourceType: "user", resourceId: "r", result: "success" });
    expect(state().auditEvents[0].tenantId).toBe("org-a");
  });
});

describe("M21.7.3 — endpoints de auditoría (plataforma vs organización)", () => {
  let server: ReturnType<Express["listen"]>;
  const cookies: Record<string, string> = {};
  const csrf: Record<string, string> = {};

  beforeAll(async () => {
    server = app.listen(0);

    const emails: Record<string, string> = {
      globalAdminNoOrg: "ap-global-no-org@example.com",
      globalAdminA: "ap-global-a@example.com",
      globalAdminB: "ap-global-b@example.com",
      orgAdminA: "ap-org-admin@example.com",
      memberA: "ap-member@example.com",
    };
    const subs: Record<string, string> = {};
    for (const [key, email] of Object.entries(emails)) {
      const res = await request(server).post("/api/auth/register").send({ email, password: PASSWORD, name: key });
      expect(res.status, `register ${key}`).toBe(201);
      subs[key] = res.body.sub as string;
    }

    state().organizations = [
      { id: "org-a", name: "Org A", slug: "org-a", status: "active", createdAt: new Date() },
      { id: "org-b", name: "Org B", slug: "org-b", status: "active", createdAt: new Date() },
    ];
    state().memberships = [
      { organizationId: "org-a", userSub: subs.globalAdminA, role: "admin", invitedBy: null, joinedAt: new Date() },
      { organizationId: "org-b", userSub: subs.globalAdminB, role: "admin", invitedBy: null, joinedAt: new Date() },
      { organizationId: "org-a", userSub: subs.orgAdminA, role: "admin", invitedBy: null, joinedAt: new Date() },
      { organizationId: "org-a", userSub: subs.memberA, role: "member", invitedBy: null, joinedAt: new Date() },
    ];
    state().userRoles.push(
      { userSub: subs.globalAdminNoOrg, role: "admin", createdAt: new Date() },
      { userSub: subs.globalAdminA, role: "admin", createdAt: new Date() },
      { userSub: subs.globalAdminB, role: "admin", createdAt: new Date() },
    );

    for (const [key, email] of Object.entries(emails)) {
      const login = await request(server).post("/api/auth/login").send({ email, password: PASSWORD });
      expect(login.status, `login ${key}`).toBe(200);
      cookies[key] = cookieOf(login);
      csrf[key] = await fetchCsrfToken(server, cookies[key]);
    }

    // Limpiar eventos de login/registro y sembrar exactamente 3 eventos de prueba.
    state().auditEvents.length = 0;
    const now = new Date();
    state().auditEvents.push(
      { id: "evt-platform", actorUserId: null, action: "user_roles_updated", resourceType: "user", resourceId: "u1", result: "success", requestId: null, metadata: {}, createdAt: new Date(now.getTime() + 1000), tenantId: null },
      { id: "evt-org-a", actorUserId: subs.globalAdminA, action: "source_created", resourceType: "source", resourceId: "s-a", result: "success", requestId: null, metadata: {}, createdAt: new Date(now.getTime() + 2000), tenantId: "org-a" },
      { id: "evt-org-b", actorUserId: subs.globalAdminB, action: "source_created", resourceType: "source", resourceId: "s-b", result: "success", requestId: null, metadata: {}, createdAt: new Date(now.getTime() + 3000), tenantId: "org-b" },
    );
  });

  afterAll(() => server.close());

  const as = (profile: string) => ({ Cookie: cookies[profile], "X-CSRF-Token": csrf[profile] });
  const get = (profile: string, url: string) => request(server).get(url).set(as(profile));
  const ids = (res: { body: Array<{ id: string }> }) => (res.body as Array<{ id: string }>).map((e) => e.id);

  it("admin global SIN org accede a /platform (200) y solo ve eventos NULL", async () => {
    const res = await get("globalAdminNoOrg", "/api/audit-events/platform");
    expect(res.status).toBe(200);
    expect(ids(res)).toEqual(["evt-platform"]);
  });

  it("admin global CON org accede a /platform (200) y solo ve eventos NULL", async () => {
    const res = await get("globalAdminA", "/api/audit-events/platform");
    expect(res.status).toBe(200);
    expect(ids(res)).toEqual(["evt-platform"]);
  });

  it("admin de org SIN rol global → /platform 403", async () => {
    expect((await get("orgAdminA", "/api/audit-events/platform")).status).toBe(403);
  });

  it("miembro de org → /platform 403", async () => {
    expect((await get("memberA", "/api/audit-events/platform")).status).toBe(403);
  });

  it("org endpoint (org-a) devuelve solo eventos de org-a, sin NULL", async () => {
    const res = await get("globalAdminA", "/api/audit-events");
    expect(res.status).toBe(200);
    expect(ids(res)).toEqual(["evt-org-a"]);
  });

  it("org endpoint (org-b) devuelve solo eventos de org-b, sin NULL", async () => {
    const res = await get("globalAdminB", "/api/audit-events");
    expect(res.status).toBe(200);
    expect(ids(res)).toEqual(["evt-org-b"]);
  });

  it("separación: platform / org-a / org-b son disjuntos", async () => {
    expect(ids(await get("globalAdminNoOrg", "/api/audit-events/platform"))).toEqual(["evt-platform"]);
    expect(ids(await get("globalAdminA", "/api/audit-events"))).toEqual(["evt-org-a"]);
    expect(ids(await get("globalAdminB", "/api/audit-events"))).toEqual(["evt-org-b"]);
  });
});

