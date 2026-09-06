/**
 * Cobertura RBAC negativa (6.3B.20): un usuario con rol `auditor` recibe 403
 * en CADA mutacion protegida con requireRole("admin"), y el rechazo ocurre
 * ANTES de cualquier mutacion (el estado del mock queda intacto, lo que
 * demuestra que no hay escritura en BD).
 *
 * Politica RBAC sin cambios: solo se demuestra el contrato existente.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import request from "supertest";
import type { Express } from "express";
import app from "../app";
import type { MockState } from "./mock-repos";

process.env.AUTH_DISABLED = "false";
process.env.JWT_SECRET = "test-secret-of-at-least-32-characters!!";
process.env.AUTH_BOOTSTRAP_TOKEN = "bootstrap-token-for-tests-only";
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

let ipSeq = 0;
const nextIp = (): string => `10.80.0.${++ipSeq}`;

function cookieOf(res: { headers: { [k: string]: unknown } }): string {
  const set = res.headers["set-cookie"] as string[] | string | undefined;
  const arr = Array.isArray(set) ? set : set ? [set] : [];
  const hit = arr.find((c) => c.startsWith("session="));
  if (!hit) throw new Error("session cookie not found");
  return hit.split(";")[0];
}

describe("RBAC negativo: auditor recibe 403 en mutaciones admin", () => {
  let server: ReturnType<Express["listen"]>;
  let cookie: string;
  let sub: string;

  beforeAll(async () => {
    server = app.listen(0);
    const reg = await request(server)
      .post("/api/auth/register")
      .set("X-Forwarded-For", nextIp())
      .send({ email: "rbac-auditor@example.com", password: "secure-password-123" });
    expect(reg.status).toBe(201);
    sub = reg.body.sub as string;
    const login = await request(server)
      .post("/api/auth/login")
      .set("X-Forwarded-For", nextIp())
      .send({ email: "rbac-auditor@example.com", password: "secure-password-123" });
    expect(login.status).toBe(200);
    cookie = cookieOf(login);
  });

  afterAll(() => {
    server.close();
  });

  it("PATCH /api/users/:sub -> 403 sin mutar el perfil", async () => {
    const target = state().users.find((u) => u.sub === sub);
    const beforeName = target?.name ?? null;
    const beforeUpdated = target?.updatedAt?.getTime();
    const res = await request(server)
      .patch(`/api/users/${sub}`)
      .set("Cookie", cookie)
      .send({ name: "Hacked" });
    expect(res.status).toBe(403);
    const after = state().users.find((u) => u.sub === sub);
    expect(after?.name).toBe(beforeName);
    expect(after?.updatedAt?.getTime()).toBe(beforeUpdated);
  });

  it("PATCH /api/users/:sub/roles -> 403 sin mutar roles", async () => {
    const before = state().userRoles.map((r) => ({
      userSub: r.userSub,
      role: r.role,
      createdAt: r.createdAt.getTime(),
    }));
    const res = await request(server)
      .patch(`/api/users/${sub}/roles`)
      .set("Cookie", cookie)
      .send({ roles: ["admin"] });
    expect(res.status).toBe(403);
    const after = state().userRoles.map((r) => ({
      userSub: r.userSub,
      role: r.role,
      createdAt: r.createdAt.getTime(),
    }));
    expect(after).toEqual(before);
    // El auditor NO gana admin (la mutación fue rechazada) y la sesión sigue sin elevarse.
    expect(after.some((r) => r.userSub === sub && r.role === "admin")).toBe(false);
  });

  it("PATCH /api/findings/:id -> 403 sin mutar", async () => {
    const f = state().findings.find((x) => x.id === "f-001");
    const beforeStatus = f?.status;
    const beforeUpdated = f?.updatedAt?.getTime();
    const res = await request(server)
      .patch("/api/findings/f-001")
      .set("Cookie", cookie)
      .send({ status: "resolved" });
    expect(res.status).toBe(403);
    const after = state().findings.find((x) => x.id === "f-001");
    expect(after?.status).toBe(beforeStatus);
    expect(after?.updatedAt?.getTime()).toBe(beforeUpdated);
  });

  it("POST /api/scans -> 403 sin crear scan", async () => {
    const before = state().scans.length;
    const res = await request(server)
      .post("/api/scans")
      .set("Cookie", cookie)
      .send({ sourceId: "src-001" });
    expect(res.status).toBe(403);
    expect(state().scans).toHaveLength(before);
  });

  it("POST /api/reports -> 403 sin crear report", async () => {
    const before = state().reports.length;
    const res = await request(server)
      .post("/api/reports")
      .set("Cookie", cookie)
      .send({ name: "Evil", period: "last_24h" });
    expect(res.status).toBe(403);
    expect(state().reports).toHaveLength(before);
  });

  it("POST /api/masking/preview -> 403 sin efectos", async () => {
    const beforeScans = state().scans.length;
    const beforeReports = state().reports.length;
    const res = await request(server)
      .post("/api/masking/preview")
      .set("Cookie", cookie)
      .send({ sourceId: "src-001", fields: ["email"] });
    expect(res.status).toBe(403);
    expect(state().scans).toHaveLength(beforeScans);
    expect(state().reports).toHaveLength(beforeReports);
  });
});
