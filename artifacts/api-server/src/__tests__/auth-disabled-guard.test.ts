import { describe, it, expect, vi, afterEach } from "vitest";
import type { NextFunction, Request, Response } from "express";
import { requireAuth, requireRole, type AuthedRequest } from "../auth/middleware";
import { assertAuthConfigForEnv, authDisabled } from "../auth/tokens";

// Suite unitaria del hardening 6.3B.7: `AUTH_DISABLED=true` está prohibido en
// producción (fail-closed), pero se conserva intacto en development/test.
// Los helpers leen el entorno en cada llamada, así que basta con stubEnv.

vi.mock("@workspace/db", () => ({
  pool: { query: vi.fn(), end: vi.fn() },
  // Stubs de tablas: el middleware importa el índice real de repositorios y
  // los módulos de repo acceden a sus tablas al evaluarse (M5.c añadió
  // maskingJobsTable). Misma técnica que compliance-repo.test.ts.
  db: {},
  findingsTable: {},
  scansTable: {},
  activityTable: {},
  sourcesTable: {},
  reportsTable: {},
  rulesTable: {},
  usersTable: {},
  userRolesTable: {},
  sessionsTable: {},
  maskingJobsTable: {},
}));

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("assertAuthConfigForEnv (startup guard)", () => {
  it("1. NODE_ENV=production + AUTH_DISABLED=true → rechaza la configuración", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("AUTH_DISABLED", "true");
    expect(() => assertAuthConfigForEnv()).toThrowError(
      /AUTH_DISABLED=true is forbidden when NODE_ENV=production/,
    );
  });

  it("1b. NODE_ENV=production + AUTH_DISABLED=1 → también rechaza", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("AUTH_DISABLED", "1");
    expect(() => assertAuthConfigForEnv()).toThrowError(/forbidden/);
  });

  it("2. NODE_ENV=production + AUTH_DISABLED=false + secret válido → configuración válida, JWT normal", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("AUTH_DISABLED", "false");
    vi.stubEnv("JWT_SECRET", "valid-secret-of-32-chars-for-guard!!");
    expect(() => assertAuthConfigForEnv()).not.toThrow();
    expect(authDisabled()).toBe(false);
  });

  it("3. NODE_ENV=development + AUTH_DISABLED=true → bypass permitido como siempre", () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("AUTH_DISABLED", "true");
    expect(() => assertAuthConfigForEnv()).not.toThrow();
    expect(authDisabled()).toBe(true);
  });

  it("3b. NODE_ENV=test + AUTH_DISABLED=true → bypass permitido (default de vitest)", () => {
    vi.stubEnv("NODE_ENV", "test");
    vi.stubEnv("AUTH_DISABLED", "true");
    expect(() => assertAuthConfigForEnv()).not.toThrow();
    expect(authDisabled()).toBe(true);
  });
});

function makeReq(extra: Record<string, unknown> = {}): Request {
  return { headers: {}, cookies: {}, ...extra } as unknown as Request;
}

function makeRes(): Response {
  return {
    set: vi.fn(),
    status: vi.fn().mockReturnThis(),
    json: vi.fn(),
  } as unknown as Response;
}

describe("requireAuth con AUTH_DISABLED=true en producción (defensa en profundidad)", () => {
  it("4. nunca inyecta la identidad dev-sub → 401 con WWW-Authenticate", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("AUTH_DISABLED", "true");
    const middleware = requireAuth();
    const req = makeReq();
    const res = makeRes();
    const next = vi.fn() as NextFunction;

    await expect(middleware(req, res, next)).rejects.toMatchObject({ status: 401 });
    expect(next).not.toHaveBeenCalled();
    expect(res.set).toHaveBeenCalledWith("WWW-Authenticate", expect.stringContaining("Bearer"));
    expect((req as AuthedRequest).user).toBeUndefined();
  });

  it("4b. requireRole tampoco se salta el chequeo → 403 sin rol admin", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("AUTH_DISABLED", "true");
    const middleware = requireRole("admin");
    const req = makeReq({
      user: { sub: "u1", email: null, name: null, roles: ["auditor"], jti: "j" },
    });
    const res = makeRes();
    const next = vi.fn() as NextFunction;

    await expect(middleware(req, res, next)).rejects.toMatchObject({ status: 403 });
    expect(next).not.toHaveBeenCalled();
  });

  it("5. en dev/test el bypass existente sigue funcionando (identidad dev-sub admin)", async () => {
    vi.stubEnv("NODE_ENV", "test");
    vi.stubEnv("AUTH_DISABLED", "true");
    const auth = requireAuth();
    const req = makeReq();
    const res = makeRes();
    const next = vi.fn() as NextFunction;

    await auth(req, res, next);
    expect(next).toHaveBeenCalledTimes(1);
    expect((req as AuthedRequest).user).toMatchObject({ sub: "dev-sub", roles: ["admin"] });

    const roleMw = requireRole("admin");
    const next2 = vi.fn() as NextFunction;
    await roleMw(req, res, next2);
    expect(next2).toHaveBeenCalledTimes(1);
  });

  it("6. producción + AUTH_DISABLED=true con JWT válido+sesión activa sigue autenticando (comportamiento JWT intacto)", async () => {
    // La protección solo desactiva el bypass; la autenticación JWT normal no
    // cambia. Aquí lo verificamos a nivel de interpretación: authDisabled()
    // es false, luego requireAuth usa el camino JWT estándar (cubierto e2e
    // por auth.test.ts con token real).
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("AUTH_DISABLED", "true");
    expect(authDisabled()).toBe(false);
  });
});

describe("assertAuthConfigForEnv: JWT_SECRET fail-fast (6.3B.21)", () => {
  it("7. secret ausente con auth habilitada → rechaza el arranque", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("AUTH_DISABLED", "false");
    vi.stubEnv("JWT_SECRET", undefined);
    expect(() => assertAuthConfigForEnv()).toThrowError(/JWT_SECRET is required/);
  });

  it("8. secret vacío → rechaza el arranque", () => {
    vi.stubEnv("NODE_ENV", "test");
    vi.stubEnv("AUTH_DISABLED", "false");
    vi.stubEnv("JWT_SECRET", "");
    expect(() => assertAuthConfigForEnv()).toThrowError(/JWT_SECRET is required/);
  });

  it("8b. secret solo espacios (trim vacío) → rechaza el arranque", () => {
    vi.stubEnv("NODE_ENV", "test");
    vi.stubEnv("AUTH_DISABLED", "false");
    vi.stubEnv("JWT_SECRET", "                                    ");
    expect(() => assertAuthConfigForEnv()).toThrowError(/JWT_SECRET is required/);
  });

  it("9. secret corto (<32) → rechaza el arranque", () => {
    vi.stubEnv("NODE_ENV", "test");
    vi.stubEnv("AUTH_DISABLED", "false");
    vi.stubEnv("JWT_SECRET", "short-secret-12");
    expect(() => assertAuthConfigForEnv()).toThrowError(/too short/);
  });

  it("9b. límite exacto: 31 chars rechaza, 32 chars acepta", () => {
    vi.stubEnv("NODE_ENV", "test");
    vi.stubEnv("AUTH_DISABLED", "false");
    vi.stubEnv("JWT_SECRET", "x".repeat(31));
    expect(() => assertAuthConfigForEnv()).toThrowError(/too short/);
    vi.stubEnv("JWT_SECRET", "y".repeat(32));
    expect(() => assertAuthConfigForEnv()).not.toThrow();
  });

  it("10. secret válido (>=32) en producción → configuración aceptada", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("AUTH_DISABLED", "false");
    vi.stubEnv("JWT_SECRET", "production-grade-secret-with-32-chars!");
    expect(() => assertAuthConfigForEnv()).not.toThrow();
  });

  it("11. bypass dev (AUTH_DISABLED=true) sin secret → arranque permitido", () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("AUTH_DISABLED", "true");
    vi.stubEnv("JWT_SECRET", undefined);
    expect(() => assertAuthConfigForEnv()).not.toThrow();
  });

  it("12. AUTH_DISABLED=true en producción tiene precedencia sobre el chequeo de secret", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("AUTH_DISABLED", "true");
    vi.stubEnv("JWT_SECRET", undefined);
    expect(() => assertAuthConfigForEnv()).toThrowError(/AUTH_DISABLED=true is forbidden/);
  });
});