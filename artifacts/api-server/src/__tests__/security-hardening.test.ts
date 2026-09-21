/**
 * M18 — Hardening de seguridad (tests).
 *
 * Cubre las brechas reales implementadas:
 * - Fase 2: rate limiting persistente (`AUTH_RATE_LIMIT_STORE=postgres`) con
 *   supervivencia a reinicios vía `rate_limit_hits` (upsert fixed-window).
 * - Fase 5: eventos de auditoría de seguridad (`inactivity_timeout`,
 *   `session_expired`, `security_violation`) con actor y requestId (M16/M17).
 * - Fase 3: barrido de sesiones huérfanas y contadores vencidos.
 *
 * El store `memory` (default) se verifica implícitamente por el resto de la
 * suite: sin la env, ningún login escribe en `state.rateLimitHits`.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import request from "supertest";
import type { Express } from "express";
import { decodeJwt } from "jose";
import type { MockState } from "./mock-repos";

process.env.AUTH_DISABLED = "false";
process.env.JWT_SECRET = "test-secret-of-at-least-32-characters!!";
process.env.AUTH_REGISTRATION_ENABLED = "true";
// M18: activa el store persistente para los limiters de autenticación.
process.env.AUTH_RATE_LIMIT_STORE = "postgres";

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

function sessionCookie(res: request.Response): string {
  const setCookie = res.headers["set-cookie"];
  const cookies = Array.isArray(setCookie) ? setCookie : [setCookie];
  const match = cookies.join(",").match(/session=[^;]+/);
  if (!match) throw new Error("session cookie not found");
  return match[0];
}

function jwtFromCookie(cookie: string): string {
  return cookie.match(/session=([^;]+)/)![1];
}

let emailSeq = 0;
function uniqueEmail(): string {
  emailSeq += 1;
  return `m18-${emailSeq}@example.com`;
}

const PASSWORD = "m18-password-123";

async function registerAndLogin(email: string, password: string) {
  await request(server).post("/api/auth/register").send({ email, password });
  const login = await request(server)
    .post("/api/auth/login")
    .send({ email, password });
  expect(login.status).toBe(200);
  return { login, cookie: sessionCookie(login) };
}

let server: ReturnType<Express["listen"]>;

describe("M18 security hardening", () => {
  beforeAll(async () => {
    // Dynamic import: AUTH_RATE_LIMIT_STORE debe estar seteada antes de que
    // `auth.ts` construya sus limiters (lectura module-scope de la env).
    const mod = await import("../app");
    server = mod.default.listen(0);
  });
  afterAll(() => {
    server.close();
  });

  describe("Fase 2 — rate limiting persistente", () => {
    it("A. bloquea el 6º login del mismo email (5/15min) y persiste el contador", async () => {
      const email = uniqueEmail();
      await request(server).post("/api/auth/register").send({ email, password: PASSWORD });
      for (let i = 0; i < 5; i += 1) {
        const ok = await request(server)
          .post("/api/auth/login")
          .send({ email, password: PASSWORD });
        expect(ok.status).toBe(200);
      }
      const blocked = await request(server)
        .post("/api/auth/login")
        .send({ email, password: PASSWORD });
      expect(blocked.status).toBe(429);

      // Persistencia: el contador vive en `rate_limit_hits` (supervive a un
      // reinicio del proceso porque no está en memoria del limiter).
      const rows = (state().rateLimitHits ?? []).filter((r) => r.hits >= 5);
      expect(rows.length).toBeGreaterThanOrEqual(1);
      expect(rows[0].expiresAt.getTime()).toBeGreaterThan(Date.now());
      // Aislamiento de buckets: la clave lleva el namespace del limiter, así
      // que el `register` previo no consumió el bucket de login (sin namespaces
      // ambos generan `${ip}:${email}` y el alta gastaba 1 de los 5 intentos).
      expect(rows[0].key.startsWith("login:")).toBe(true);
      expect(
        (state().rateLimitHits ?? []).some((r) => r.key.startsWith("register:")),
      ).toBe(true);
    });

    it("B. una ventana persistida ya vencida se reinicia (no bloquea para siempre)", async () => {
      const email = uniqueEmail();
      await request(server)
        .post("/api/auth/register")
        .send({ email, password: PASSWORD });
      for (let i = 0; i < 5; i += 1) {
        const ok = await request(server)
          .post("/api/auth/login")
          .send({ email, password: PASSWORD });
        expect(ok.status).toBe(200);
      }
      const blocked = await request(server)
        .post("/api/auth/login")
        .send({ email, password: PASSWORD });
      expect(blocked.status).toBe(429);

      // Escenario "reinicio del proceso": el bucket agotado vive en la BD y su
      // ventana ya expiró. El siguiente intento debe reiniciar el contador
      // (fixed window), no heredar el bloqueo indefinidamente.
      const counter = (state().rateLimitHits ?? []).find(
        (r) => r.key.startsWith("login:") && r.key.endsWith(email),
      );
      expect(counter).toBeDefined();
      expect(counter!.hits).toBeGreaterThanOrEqual(6);
      counter!.expiresAt = new Date(Date.now() - 1_000);

      const afterWindow = await request(server)
        .post("/api/auth/login")
        .send({ email, password: PASSWORD });
      expect(afterWindow.status).toBe(200);
      expect(counter!.hits).toBe(1); // ventana reiniciada por el upsert
    });
  });

  describe("Fase 5 — eventos de seguridad en auditoría", () => {
    it("D. registra inactivity_timeout con actor y requestId al rechazar por idle", async () => {
      const email = uniqueEmail();
      const { cookie } = await registerAndLogin(email, PASSWORD);
      const jwt = decodeJwt(jwtFromCookie(cookie));
      const jti = jwt.jti as string;
      const sub = jwt.sub as string;
      const session = state().sessions.find((s) => s.jti === jti)!;
      session.lastUsedAt = new Date(Date.now() - 2 * 60 * 60 * 1000); // 2h > 1800s

      const res = await request(server)
        .get("/api/auth/me")
        .set("Cookie", cookie)
        .set("X-Request-Id", "m18-idle-1");
      expect(res.status).toBe(401);

      const event = state().auditEvents.find(
        (e) => e.action === "inactivity_timeout" && e.resourceId === jti,
      );
      expect(event).toBeDefined();
      expect(event!.actorUserId).toBe(sub);
      expect(event!.result).toBe("failure");
      expect(event!.requestId).toBe("m18-idle-1");
      expect(event!.metadata).toMatchObject({ reason: "inactivity_timeout" });
    });

    it("E. registra session_expired cuando la sesión absoluta venció", async () => {
      const email = uniqueEmail();
      const { cookie } = await registerAndLogin(email, PASSWORD);
      const jti = decodeJwt(jwtFromCookie(cookie)).jti as string;
      const session = state().sessions.find((s) => s.jti === jti)!;
      session.expiresAt = new Date(Date.now() - 5_000);

      const res = await request(server)
        .get("/api/auth/me")
        .set("Cookie", cookie);
      expect(res.status).toBe(401);

      const event = state().auditEvents.find(
        (e) => e.action === "session_expired" && e.resourceId === jti,
      );
      expect(event).toBeDefined();
      expect(event!.result).toBe("failure");
    });

    it("F. registra security_violation ante CSRF faltante en mutación autenticada", async () => {
      const email = uniqueEmail();
      const { cookie } = await registerAndLogin(email, PASSWORD);
      const sub = decodeJwt(jwtFromCookie(cookie)).sub as string;

      const res = await request(server)
        .post("/api/auth/password/change")
        .set("Cookie", cookie)
        // Sin X-CSRF-Token: requireCsrf rechaza fail-closed.
        .send({ currentPassword: PASSWORD, newPassword: "m18-new-pass-456" });
      expect(res.status).toBe(403);

      const event = state().auditEvents.find(
        (e) => e.action === "security_violation" && e.actorUserId === sub,
      );
      expect(event).toBeDefined();
      expect(event!.metadata).toMatchObject({ reason: "csrf_token_invalid" });
      // La auditoría nunca contiene credenciales, cookies ni tokens.
      const serialized = JSON.stringify(event);
      expect(serialized).not.toContain(PASSWORD);
      expect(serialized).not.toContain("session=");
    });

    it("G. sesión revocada NO genera evento duplicado (ya se audita al revocar)", async () => {
      const email = uniqueEmail();
      const { cookie } = await registerAndLogin(email, PASSWORD);
      const jti = decodeJwt(jwtFromCookie(cookie)).jti as string;
      const session = state().sessions.find((s) => s.jti === jti)!;
      session.revokedAt = new Date();

      const before = state().auditEvents.filter(
        (e) => e.resourceId === jti,
      ).length;
      const res = await request(server)
        .get("/api/auth/me")
        .set("Cookie", cookie);
      expect(res.status).toBe(401);
      const after = state().auditEvents.filter(
        (e) => e.resourceId === jti,
      ).length;
      expect(after).toBe(before); // sin evento nuevo de rechazo
    });
  });

  describe("Fase 3 — barrido de sesiones y contadores", () => {
    it("H. purga sesiones expiradas/revocadas viejas y contadores vencidos; conserva los vivos", async () => {
      const now = Date.now();
      const stale = new Date(now - 40 * 24 * 60 * 60 * 1000); // > retención 30d
      const s = state();
      s.sessions.push(
        {
          jti: "m18-expired-stale",
          userSub: "user-m18-a",
          issuedAt: new Date(now - 41 * 24 * 60 * 60 * 1000),
          expiresAt: stale,
          revokedAt: null,
          lastUsedAt: new Date(),
        },
        {
          jti: "m18-revoked-stale",
          userSub: "user-m18-a",
          issuedAt: new Date(now - 41 * 24 * 60 * 60 * 1000),
          expiresAt: new Date(now + 24 * 60 * 60 * 1000),
          revokedAt: stale,
          lastUsedAt: new Date(),
        },
        {
          jti: "m18-alive",
          userSub: "user-m18-b",
          issuedAt: new Date(),
          expiresAt: new Date(now + 60 * 60 * 1000),
          revokedAt: null,
          lastUsedAt: new Date(),
        },
      );
      const hits = (s.rateLimitHits ??= []);
      hits.push(
        {
          key: "m18-stale-counter",
          hits: 3,
          windowStartAt: new Date(now - 3_600_000),
          expiresAt: new Date(now - 60_000), // vencido
        },
        {
          key: "m18-live-counter",
          hits: 1,
          windowStartAt: new Date(now),
          expiresAt: new Date(now + 3_600_000),
        },
      );

      const { runSessionCleanupSafely } = await import(
        "../services/session-cleanup"
      );
      await runSessionCleanupSafely();

      const jtis = s.sessions.map((x) => x.jti);
      expect(jtis).not.toContain("m18-expired-stale");
      expect(jtis).not.toContain("m18-revoked-stale");
      expect(jtis).toContain("m18-alive");
      // Re-lectura del estado: el repo reemplaza el array al filtrar (no muta
      // in place), así que la referencia capturada antes del barrido queda
      // obsoleta.
      const remaining = state().rateLimitHits ?? [];
      expect(
        remaining.find((h) => h.key === "m18-stale-counter"),
      ).toBeUndefined();
      expect(remaining.find((h) => h.key === "m18-live-counter")).toBeDefined();
    });
  });

  describe("Fase 6 — límites de entrada", () => {
    it("I. register rechaza un password por encima del tope (sin llegar a scrypt)", async () => {
      const email = uniqueEmail();
      const res = await request(server)
        .post("/api/auth/register")
        .send({ email, password: "a".repeat(1025) });
      expect(res.status).toBe(400);
      expect(String(res.body.detail)).toContain("at most 1024");
      // Rechazo previo a cualquier escritura: no hay usuario ni bucket.
      expect(state().users.some((u) => u.email === email)).toBe(false);
    });

    it("J. register rechaza emails desmedidos y descarta nombres fuera de rango", async () => {
      const oversizedEmail = `${"x".repeat(250)}@example.com`; // 262 > 254
      const rejected = await request(server)
        .post("/api/auth/register")
        .send({ email: oversizedEmail, password: PASSWORD });
      expect(rejected.status).toBe(400);

      const ok = await request(server)
        .post("/api/auth/register")
        .send({
          email: uniqueEmail(),
          password: PASSWORD,
          name: "n".repeat(300), // 300 > 200
        });
      expect(ok.status).toBe(201);
      // El nombre opcional fuera de rango no se almacena (no se trunca).
      const created = state().users.find((u) => u.email === ok.body.email)!;
      expect(created.name).toBeNull();
    });

    it("K. login con password desmedido → 401 uniforme, auditado y sin scrypt", async () => {
      const email = uniqueEmail();
      await request(server)
        .post("/api/auth/register")
        .send({ email, password: PASSWORD });

      const res = await request(server)
        .post("/api/auth/login")
        .send({ email, password: "a".repeat(5000) });
      expect(res.status).toBe(401);
      expect(res.body.detail).toBe("Invalid credentials"); // mismo mensaje que credenciales inválidas

      const failures = state().auditEvents.filter(
        (e) => e.action === "login_failure",
      );
      const event = failures[failures.length - 1]!;
      expect(event.metadata).toMatchObject({
        method: "local",
        reason: "password_too_long",
      });
      // El valor rechazado nunca se persiste en la auditoría.
      expect(JSON.stringify(event)).not.toContain("aaaa");
    });
  });
});
