import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from "vitest";
import request from "supertest";
import type { Express } from "express";
import app from "../app";
import type { MockState } from "./mock-repos";

process.env.AUTH_DISABLED = "false";
process.env.JWT_SECRET = "test-secret-of-at-least-32-characters!!";
process.env.AUTH_BOOTSTRAP_TOKEN = "bootstrap-token-for-tests-only";
process.env.AUTH_BOOTSTRAP_ENABLED = "true"; // bootstrap opt-in (6.3B.15)
process.env.AUTH_REGISTRATION_ENABLED = "true"; // registro opt-in para sembrar auditor (6.3B.20)

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

function extractCookie(setCookie: string | string[] | undefined): string {
  const cookies = Array.isArray(setCookie) ? setCookie : [setCookie ?? ""];
  const match = cookies.join(",").match(/session=[^;]+/);
  if (!match) throw new Error("session cookie not found");
  return match[0];
}

/** Espia sobre findings.list para verificar el argumento de paginacion recibido. */
function spyFindingsList() {
  const patch = mocks.repos as unknown as {
    findings: { list: (args: unknown) => Promise<unknown> };
  };
  return vi.spyOn(patch.findings, "list");
}

/**
 * F4 - Paginacion server-side (6.3B.20).
 * El limite se aplica en la query de DB (LIMIT/OFFSET) y en el mock
 * (slice con el mismo contrato: default limit=50, max 100, offset>=0).
 * La respuesta mantiene el contrato array preexistente (backward-compatible).
 */
describe("F4 - Paginacion server-side en listados", () => {
  let server: ReturnType<Express["listen"]>;
  let auditorCookie: string;
  let adminCookie: string;

  beforeAll(async () => {
    server = app.listen(0);

    // auditor: registro + login (registro opt-in habilitado arriba)
    await request(server)
      .post("/api/auth/register")
      .send({ email: "pager-auditor@example.com", password: "secure-password-123" });
    const login = await request(server)
      .post("/api/auth/login")
      .send({ email: "pager-auditor@example.com", password: "secure-password-123" });
    expect(login.status).toBe(200);
    auditorCookie = extractCookie(login.headers["set-cookie"]);

    // admin: bootstrap (IP propia para no rozar el limiter)
    const boot = await request(server)
      .post("/api/auth/login")
      .set("X-Forwarded-For", "10.7.0.1")
      .send({ token: "bootstrap-token-for-tests-only" });
    expect(boot.status).toBe(200);
    adminCookie = extractCookie(boot.headers["set-cookie"]);
  });

  afterAll(() => {
    server.close();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("default: limit=50 y offset=0 llegan al repository (espia)", async () => {
    const spy = spyFindingsList();
    const res = await request(server).get("/api/findings").set("Cookie", auditorCookie);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(spy).toHaveBeenCalledTimes(1);
    // La paginacion viaja como 2º argumento (1º = filtros); se serializa la
    // llamada completa para ser agnostico a la posicion/anidado.
    const argJson = JSON.stringify(spy.mock.calls[0]);
    expect(argJson).toContain('"limit":50');
    expect(argJson).toContain('"offset":0');
  });

  it("limit explicito valido y orden estable entre peticiones identicas", async () => {
    const a = await request(server).get("/api/findings?limit=2").set("Cookie", auditorCookie);
    const b = await request(server).get("/api/findings?limit=2").set("Cookie", auditorCookie);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(a.body).toHaveLength(2);
    expect(b.body).toEqual(a.body);
  });

  it("limit maximo (100) aceptado; nunca devuelve mas de 100", async () => {
    const res = await request(server).get("/api/findings?limit=100").set("Cookie", auditorCookie);
    expect(res.status).toBe(200);
    expect(res.body.length).toBeLessThanOrEqual(100);
  });

  it("limit superior al maximo (999999999) -> 400, sin bypass", async () => {
    const res = await request(server)
      .get("/api/findings?limit=999999999")
      .set("Cookie", auditorCookie);
    expect(res.status).toBe(400);
    expect(res.body.status).toBe(400);
  });

  it("limit invalido (0) -> 400", async () => {
    const res = await request(server).get("/api/findings?limit=0").set("Cookie", auditorCookie);
    expect(res.status).toBe(400);
  });

  it("limit no numerico -> 400", async () => {
    const res = await request(server).get("/api/findings?limit=abc").set("Cookie", auditorCookie);
    expect(res.status).toBe(400);
  });

  it("offset negativo -> 400", async () => {
    const res = await request(server).get("/api/findings?offset=-1").set("Cookie", auditorCookie);
    expect(res.status).toBe(400);
  });

  it("segmentacion correcta: paginas consecutivas sin solape y ultima parcial", async () => {
    const page1 = await request(server)
      .get("/api/findings?limit=2&offset=0")
      .set("Cookie", auditorCookie);
    const page2 = await request(server)
      .get("/api/findings?limit=2&offset=2")
      .set("Cookie", auditorCookie);
    const page3 = await request(server)
      .get("/api/findings?limit=2&offset=4")
      .set("Cookie", auditorCookie);
    expect(page1.status).toBe(200);
    expect(page2.status).toBe(200);
    expect(page3.status).toBe(200);
    const ids1: string[] = page1.body.map((f: { id: string }) => f.id);
    const ids2: string[] = page2.body.map((f: { id: string }) => f.id);
    expect(ids1.some((id) => ids2.includes(id))).toBe(false);
    // 5 findings sembrados: 2 + 2 + 1
    expect(page1.body).toHaveLength(2);
    expect(page2.body).toHaveLength(2);
    expect(page3.body).toHaveLength(1);
  });

  it("activity respeta la paginacion (default <=50 y segmentacion limit=2)", async () => {
    const all = await request(server).get("/api/activity").set("Cookie", auditorCookie);
    expect(all.status).toBe(200);
    expect(all.body.length).toBeLessThanOrEqual(50);
    const page = await request(server).get("/api/activity?limit=2").set("Cookie", auditorCookie);
    expect(page.status).toBe(200);
    expect(page.body).toHaveLength(2);
  });

  it("/users (admin) respeta la paginacion", async () => {
    const all = await request(server).get("/api/users").set("Cookie", adminCookie);
    expect(all.status).toBe(200);
    expect(Array.isArray(all.body)).toBe(true);
    const page = await request(server).get("/api/users?limit=1").set("Cookie", adminCookie);
    expect(page.status).toBe(200);
    expect(page.body).toHaveLength(1);
    const over = await request(server).get("/api/users?limit=500").set("Cookie", adminCookie);
    expect(over.status).toBe(400);
  });

  // --- Bordes 6.3B.21 (Parte B) ---

  it("borde: limit=1 devuelve exactamente un elemento", async () => {
    const res = await request(server).get("/api/findings?limit=1").set("Cookie", auditorCookie);
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
  });

  it("borde: limit=100 devuelve todos los sembrados (5) sin exceder el maximo", async () => {
    const res = await request(server).get("/api/findings?limit=100").set("Cookie", auditorCookie);
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(5);
  });

  it("borde: offset fuera de rango -> 200 con array vacio (sin error 500)", async () => {
    const res = await request(server)
      .get("/api/findings?limit=50&offset=1000")
      .set("Cookie", auditorCookie);
    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });

  it("borde: ultima pagina parcial en activity (limit=3&offset=3 -> 2 de 5)", async () => {
    const res = await request(server)
      .get("/api/activity?limit=3&offset=3")
      .set("Cookie", auditorCookie);
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(2);
  });
});
