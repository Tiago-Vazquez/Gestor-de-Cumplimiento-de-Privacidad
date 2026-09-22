import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import request from "supertest";
import type { Express } from "express";
import app from "../app";
import type { MockState } from "./mock-repos";
import { fetchCsrfToken } from "./test-utils";

/**
 * M21.3 — Aislamiento por tenant (D2: `tenant_id = org OR tenant_id IS NULL`).
 *
 * Casos negativos del diagnóstico:
 * - Un usuario de `org-a` NO puede listar/leer/mutar recursos de `org-b`.
 * - Los recursos legacy (`tenant_id IS NULL`) siguen siendo visibles para
 *   TODAS las organizaciones (compatibilidad transitoria hasta M21.4).
 */
process.env.AUTH_DISABLED = "false";
process.env.JWT_SECRET = "test-secret-of-at-least-32-characters!!";
process.env.AUTH_BOOTSTRAP_ENABLED = "true";
process.env.AUTH_BOOTSTRAP_TOKEN = "bootstrap-token-for-tests-only";
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

describe("M21.3 tenant isolation (D2)", () => {
  let server: ReturnType<Express["listen"]>;
  let cookieA: string;
  let cookieB: string;
  let csrfA: string;
  let csrfB: string;
  let srcA: string;
  let srcB: string;

  beforeAll(async () => {
    server = app.listen(0);

    const regA = await request(server)
      .post("/api/auth/register")
      .send({ email: "tenant-a@example.com", password: "secure-password-123", name: "Tenant A" });
    expect(regA.status).toBe(201);
    const regB = await request(server)
      .post("/api/auth/register")
      .send({ email: "tenant-b@example.com", password: "secure-password-123", name: "Tenant B" });
    expect(regB.status).toBe(201);

    const subA = regA.body.sub as string;
    const subB = regB.body.sub as string;

    state().organizations = [
      { id: "org-a", name: "Org A", slug: "org-a", status: "active", createdAt: new Date() },
      { id: "org-b", name: "Org B", slug: "org-b", status: "active", createdAt: new Date() },
    ];
    state().memberships = [
      { organizationId: "org-a", userSub: subA, role: "owner", invitedBy: null, joinedAt: new Date() },
      { organizationId: "org-b", userSub: subB, role: "owner", invitedBy: null, joinedAt: new Date() },
    ];
    state().userRoles.push({ userSub: subA, role: "admin", createdAt: new Date() });
    state().userRoles.push({ userSub: subB, role: "admin", createdAt: new Date() });

    const loginA = await request(server)
      .post("/api/auth/login")
      .send({ email: "tenant-a@example.com", password: "secure-password-123" });
    expect(loginA.status).toBe(200);
    cookieA = cookieOf(loginA);
    csrfA = await fetchCsrfToken(server, cookieA);

    const loginB = await request(server)
      .post("/api/auth/login")
      .send({ email: "tenant-b@example.com", password: "secure-password-123" });
    expect(loginB.status).toBe(200);
    cookieB = cookieOf(loginB);
    csrfB = await fetchCsrfToken(server, cookieB);

    const createA = await request(server)
      .post("/api/sources")
      .set("Cookie", cookieA)
      .set("X-CSRF-Token", csrfA)
      .send({ name: "Source A", kind: "postgresql", environment: "production" });
    expect(createA.status).toBe(201);
    srcA = createA.body.id as string;

    const createB = await request(server)
      .post("/api/sources")
      .set("Cookie", cookieB)
      .set("X-CSRF-Token", csrfB)
      .send({ name: "Source B", kind: "postgresql", environment: "production" });
    expect(createB.status).toBe(201);
    srcB = createB.body.id as string;

    const now = new Date();
    state().findings.push({
      id: "f-a", title: "Finding A", dataType: "email", sourceId: srcA, sourceName: "Source A",
      location: "t.c", severity: "high", status: "open", records: 1, detectedAt: now,
      regulation: "GDPR", recommendation: "x", sample: "s", createdAt: now, updatedAt: now,
      scanId: null, fingerprint: null, firstSeenAt: null, lastSeenAt: null, lastSeenScanId: null,
      superseded: false, tenantId: "org-a",
    });
    state().findings.push({
      id: "f-b", title: "Finding B", dataType: "email", sourceId: srcB, sourceName: "Source B",
      location: "t.c", severity: "high", status: "open", records: 1, detectedAt: now,
      regulation: "GDPR", recommendation: "x", sample: "s", createdAt: now, updatedAt: now,
      scanId: null, fingerprint: null, firstSeenAt: null, lastSeenAt: null, lastSeenScanId: null,
      superseded: false, tenantId: "org-b",
    });
  });

  afterAll(() => {
    server.close();
  });

  it("el listado de sources no filtra datos legacy (tenant_id NULL) y aísla los del otro tenant", async () => {
    const listA = await request(server).get("/api/sources").set("Cookie", cookieA);
    expect(listA.status).toBe(200);
    const namesA = (listA.body as Array<{ name: string }>).map((s) => s.name);
    expect(namesA).toContain("Source A");
    expect(namesA).not.toContain("Source B");
    // Legacy (src-001..004, tenant_id NULL) siguen visibles en ambas orgs.
    expect(namesA).toContain("Customer PostgreSQL");
  });

  it("GET de un source ajeno → 404 (BOLA cerrado)", async () => {
    const res = await request(server).get(`/api/sources/${srcB}`).set("Cookie", cookieA);
    expect(res.status).toBe(404);
  });

  it("PATCH de un source ajeno → 404, sin mutar", async () => {
    const res = await request(server)
      .patch(`/api/sources/${srcB}`)
      .set("Cookie", cookieA)
      .set("X-CSRF-Token", csrfA)
      .send({ name: "Hacked" });
    expect(res.status).toBe(404);
  });

  it("DELETE de un source ajeno → 404, el recurso sobrevive", async () => {
    const res = await request(server)
      .delete(`/api/sources/${srcB}`)
      .set("Cookie", cookieA)
      .set("X-CSRF-Token", csrfA);
    expect(res.status).toBe(404);
    const stillThere = await request(server).get(`/api/sources/${srcB}`).set("Cookie", cookieB);
    expect(stillThere.status).toBe(200);
  });

  it("el listado de findings aísla por tenant", async () => {
    const listA = await request(server).get("/api/findings").set("Cookie", cookieA);
    expect(listA.status).toBe(200);
    const idsA = (listA.body as Array<{ id: string }>).map((f) => f.id);
    expect(idsA).toContain("f-a");
    expect(idsA).not.toContain("f-b");
  });

  it("PATCH de un finding ajeno → 404 (BOLA cerrado)", async () => {
    const res = await request(server)
      .patch("/api/findings/f-b")
      .set("Cookie", cookieA)
      .set("X-CSRF-Token", csrfA)
      .send({ status: "resolved" });
    expect(res.status).toBe(404);
  });

  it("POST /scans sobre un source ajeno → 404 (no inicia escaneo cruzado)", async () => {
    const res = await request(server)
      .post("/api/scans")
      .set("Cookie", cookieA)
      .set("X-CSRF-Token", csrfA)
      .send({ sourceId: srcB });
    expect(res.status).toBe(404);
  });
});
