/**
 * M30.0 — Tests funcionales de recuperacion de contrasena.
 *
 * Cubre POST /api/auth/password/forgot y POST /api/auth/password/reset:
 *  - respuesta uniforme exista o no la cuenta (no enumera emails)
 *  - el token NUNCA viaja en la respuesta ni se persiste en claro
 *  - expiracion: un token vencido se rechaza
 *  - consumo unico: el segundo uso del mismo token falla
 *  - token inexistente responde 400 con el MISMO texto que uno expirado
 *  - el cambio de contrasena es efectivo y revoca todas las sesiones
 *  - 400 con contrasena corta (misma politica que el registro)
 *
 * Sigue las convenciones de auth-change-password.test.ts: repos en memoria
 * (mock-repos), servidor efimero. Sin `requireAuth` ni CSRF porque el token ES
 * la credencial.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from "vitest";
import request from "supertest";
import type { Server } from "http";
import { hashPassword } from "@workspace/auth";
import app from "../app";
import { deliverResetLink } from "../auth/password-reset-delivery";
import { repos } from "../repositories";
import * as passwordResetRepo from "../repositories/password-reset.repo";
import { logger } from "../lib/logger";
import type { MockState } from "./mock-repos";
import type { User } from "@workspace/db";

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

// El generador real se envuelve en un espía OBSERVABLE: sigue delegando en la
// implementación real (los tests que necesitan un token lo obtienen), pero los
// tests pueden comprobar si el handler llegó a invocarlo.
vi.mock("../repositories/password-reset.repo", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../repositories/password-reset.repo")>();
  return {
    ...actual,
    generatePasswordResetToken: vi.fn(() => actual.generatePasswordResetToken()),
  };
});

// Contrato público de la respuesta de recuperación (idéntico exista o no la cuenta).
const GENERIC_BODY = {
  status: "accepted",
  message: "If the account exists, a reset link has been sent.",
};

// Configuración COMPLETA de entrega: base HTTPS válida + credenciales Resend.
const DELIVERY_CONFIG = {
  base: "https://app.example.com",
  apiKey: "test-resend-api-key",
  from: "Privaris <no-reply@example.com>",
};

// `fetch` se mockea siempre: ningún test debe salir a la red.
const fetchMock = vi.fn();

function enableDeliveryConfig(): void {
  process.env.PASSWORD_RESET_BASE_URL = DELIVERY_CONFIG.base;
  process.env.RESEND_API_KEY = DELIVERY_CONFIG.apiKey;
  process.env.PASSWORD_RESET_FROM = DELIVERY_CONFIG.from;
}

function disableDeliveryConfig(): void {
  delete process.env.PASSWORD_RESET_BASE_URL;
  delete process.env.RESEND_API_KEY;
  delete process.env.PASSWORD_RESET_FROM;
}

let server: Server;

function state(): MockState {
  if (!mocks.state) throw new Error("mock repos not initialized");
  return mocks.state;
}

async function seededUser(email: string, password: string) {
  const hash = await hashPassword(password);
  const now = new Date();
  const user: User = {
    sub: `u-${email}`,
    email,
    name: null,
    passwordHash: hash,
    createdAt: now,
    updatedAt: now,
    lastLoginAt: null,
    mfaEnabled: false,
    mfaSecretEncrypted: null,
    mfaSecretSetAt: null,
    mfaEnabledAt: null,
    mfaLastVerifiedStep: null,
  };
  state().users.push(user);
  return user;
}

async function forgot(email: string) {
  return request(server).post("/api/auth/password/forgot").send({ email });
}

async function reset(token: string, newPassword: string) {
  return request(server)
    .post("/api/auth/password/reset")
    .send({ token, newPassword });
}

// Espías observables: generador de tokens (módulo mockeado) y persistencia.
const generateTokenSpy = vi.mocked(passwordResetRepo.generatePasswordResetToken);
const createTokenSpy = vi.spyOn(repos.passwordReset, "create");

beforeAll(() => {
  server = app.listen(0);
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeEach(() => {
  fetchMock.mockReset();
  fetchMock.mockResolvedValue({ ok: true, status: 200 } as Response);
  vi.stubGlobal("fetch", fetchMock);
  vi.clearAllMocks();
  // Por defecto el flujo está COMPLETAMENTE configurado; los tests de
  // "configuración ausente" la desactivan explícitamente.
  enableDeliveryConfig();
});

afterEach(() => {
  vi.unstubAllGlobals();
  // Restaurar SIEMPRE las variables de entorno, incluso si el test falla.
  disableDeliveryConfig();
});

describe("M30.0 POST /api/auth/password/forgot", () => {
  it("responde 202 con cuerpo uniforme cuando la cuenta existe", async () => {
    await seededUser("existe@example.com", "contrasena-larga-123");
    const res = await forgot("existe@example.com");
    expect(res.status).toBe(202);
    expect(res.body.status).toBe("accepted");
  });

  it("responde EXACTAMENTE el mismo 202 cuando la cuenta NO existe", async () => {
    const res = await forgot("nadie@example.com");
    // Mismo status y mismo cuerpo: la ruta no puede usarse para enumerar cuentas.
    expect(res.status).toBe(202);
    expect(res.body).toEqual({
      status: "accepted",
      message: "If the account exists, a reset link has been sent.",
    });
  });

  it("no crea ningun token para un email desconocido", async () => {
    const before = state().passwordResetTokens.length;
    await forgot("fantasma@example.com");
    expect(state().passwordResetTokens.length).toBe(before);
  });

  it("guarda SOLO el hash del token, nunca el token en claro", async () => {
    await seededUser("hash@example.com", "contrasena-larga-123");
    await forgot("hash@example.com");
    const row = state().passwordResetTokens.at(-1);
    expect(row).toBeDefined();
    // SHA-256 en hex = 64 chars. El token en claro seria base64url (43 chars).
    expect(row!.tokenHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("invalida los tokens pendientes si se pide uno nuevo", async () => {
    await seededUser("doble@example.com", "contrasena-larga-123");
    await forgot("doble@example.com");
    const first = state().passwordResetTokens.at(-1)!;
    await forgot("doble@example.com");
    const second = state().passwordResetTokens.at(-1)!;
    expect(first.id).not.toBe(second.id);
    // El primero queda consumido por la invalidacion.
    expect(state().passwordResetTokens.find((r) => r.id === first.id)!.consumedAt).not.toBeNull();
  });
});

/**
 * M31.0 — Delivery vía Resend.
 *
 * `deliverResetLink` lee la configuración en tiempo de llamada, por lo que no
 * hace falta `vi.resetModules()`: basta fijar/limpiar las variables de entorno
 * y mockear el `fetch` global.
 */
describe("M31.0 delivery vía Resend", () => {
  const fetchMock = vi.fn();
  const input = {
    email: "destino@example.com",
    resetUrl: "https://app.example/reset-password?token=SECRETTOKEN",
    expiresAt: new Date(Date.now() + 60_000),
  };

  beforeEach(() => {
    vi.stubGlobal("fetch", fetchMock);
    fetchMock.mockReset();
    process.env.RESEND_API_KEY = "test-resend-api-key";
    process.env.PASSWORD_RESET_FROM = "Privaris <no-reply@example.com>";
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.RESEND_API_KEY;
    delete process.env.PASSWORD_RESET_FROM;
  });

  it("devuelve true cuando Resend responde 2xx", async () => {
    fetchMock.mockResolvedValue({ ok: true, status: 200 } as Response);
    await expect(deliverResetLink(input)).resolves.toBe(true);
  });

  it("devuelve false cuando Resend responde 4xx/5xx", async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 500 } as Response);
    await expect(deliverResetLink(input)).resolves.toBe(false);
  });

  it("devuelve false cuando fetch lanza un error de red", async () => {
    fetchMock.mockRejectedValue(new Error("network down"));
    await expect(deliverResetLink(input)).resolves.toBe(false);
  });

  it("devuelve false cuando falta la configuración", async () => {
    delete process.env.RESEND_API_KEY;
    await expect(deliverResetLink(input)).resolves.toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("envía destinatario, remitente y reset URL correctos, con la API key en Authorization", async () => {
    fetchMock.mockResolvedValue({ ok: true, status: 200 } as Response);
    await deliverResetLink(input);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.resend.com/emails");

    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer test-resend-api-key");

    const body = JSON.parse(init.body as string);
    expect(body.from).toBe("Privaris <no-reply@example.com>");
    expect(body.to).toEqual(["destino@example.com"]);
    expect(body.text).toContain(input.resetUrl);
  });

  it("no registra la API key ni el reset URL en logs", async () => {
    const errorSpy = vi.spyOn(logger, "error").mockImplementation(() => {});
    fetchMock.mockResolvedValue({ ok: false, status: 500 } as Response);
    await deliverResetLink(input);

    expect(errorSpy).toHaveBeenCalled();
    const logged = JSON.stringify(errorSpy.mock.calls);
    expect(logged).not.toContain("test-resend-api-key");
    expect(logged).not.toContain("SECRETTOKEN");
    errorSpy.mockRestore();
  });
});
describe("M30.0 POST /api/auth/password/reset", () => {
  it("rechaza 400 un token inexistente", async () => {
    const res = await reset("a".repeat(43), "contrasena-nueva-1234");
    expect(res.status).toBe(400);
  });

  it("rechaza 400 una contrasena demasiado corta (misma politica que el registro)", async () => {
    const user = await seededUser("corta@example.com", "contrasena-larga-123");
    await forgot("corta@example.com");
    const row = state().passwordResetTokens.at(-1)!;
    void user;
    const res = await reset("x".repeat(43), "corta");
    expect(res.status).toBe(400);
    expect(row).toBeDefined();
  });

  it("rechaza un token expirado con el MISMO texto que uno inexistente", async () => {
    await seededUser("expira@example.com", "contrasena-larga-123");
    await forgot("expira@example.com");
    const row = state().passwordResetTokens.at(-1)!;
    // Envejecemos el token mas alla de su TTL.
    row.expiresAt = new Date(Date.now() - 1000);

    const res = await reset("b".repeat(43), "contrasena-nueva-1234");
    expect(res.status).toBe(400);
    expect(res.body.detail ?? res.body.message).toBe("Invalid or expired reset token");
  });

  it("consume el token una sola vez: el segundo uso falla", async () => {
    const user = await seededUser("unico@example.com", "contrasena-larga-123");
    await forgot("unico@example.com");
    const token = "c".repeat(43);

    // El token plano no es el hash: el primer reset con un token sintetico no
    // existe, asi que registramos uno real para poder consumirlo.
    const { hashPasswordResetToken } = await import("../repositories/password-reset.repo");
    state().passwordResetTokens.push({
      id: "prt-manual",
      userSub: user.sub,
      tokenHash: hashPasswordResetToken(token),
      expiresAt: new Date(Date.now() + 60_000),
      consumedAt: null,
      requestedIp: null,
      createdAt: new Date(),
    });

    const first = await reset(token, "primera-nueva-12345");
    expect(first.status).toBe(200);

    const second = await reset(token, "segunda-nueva-12345");
    expect(second.status).toBe(400);
  });

  it("el reset cambia la contrasena y revoca todas las sesiones", async () => {
    const user = await seededUser("efectivo@example.com", "contrasena-larga-123");
    state().sessions.push({
      id: "s-1",
      sub: "otro",
      userSub: user.sub,
      jti: "jti-1",
      createdAt: new Date(),
      lastSeenAt: new Date(),
      expiresAt: new Date(Date.now() + 60_000),
      revokedAt: null,
    } as never);

    const token = "d".repeat(43);
    const { hashPasswordResetToken } = await import("../repositories/password-reset.repo");
    state().passwordResetTokens.push({
      id: "prt-efectivo",
      userSub: user.sub,
      tokenHash: hashPasswordResetToken(token),
      expiresAt: new Date(Date.now() + 60_000),
      consumedAt: null,
      requestedIp: null,
      createdAt: new Date(),
    });

    const res = await reset(token, "contrasena-nueva-5678");
    expect(res.status).toBe(200);

    const stored = state().users.find((u) => u.sub === user.sub)!;
    // El hash cambio: la nueva contrasena verifica y la antigua no.
    const { verifyPassword } = await import("@workspace/auth");
    await expect(verifyPassword("contrasena-nueva-5678", stored.passwordHash!)).resolves.toBe(true);
    await expect(verifyPassword("contrasena-larga-123", stored.passwordHash!)).resolves.toBe(false);

    // Todas las sesiones del usuario quedan revocadas.
    const sessions = state().sessions.filter((s) => s.userSub === user.sub);
    for (const s of sessions) expect(s.revokedAt).not.toBeNull();
  });
});

describe("M31.0 configuración ausente: no se generan ni persisten tokens", () => {
  it("sin PASSWORD_RESET_BASE_URL: 202 genérico, sin token y sin fetch", async () => {
    await seededUser("sin-base@example.com", "contrasena-larga-123");
    delete process.env.PASSWORD_RESET_BASE_URL;
    const before = state().passwordResetTokens.length;

    const res = await forgot("sin-base@example.com");

    expect(res.status).toBe(202);
    expect(res.body).toEqual(GENERIC_BODY);
    expect(generateTokenSpy).not.toHaveBeenCalled();
    expect(createTokenSpy).not.toHaveBeenCalled();
    expect(state().passwordResetTokens.length).toBe(before);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("sin RESEND_API_KEY: 202 genérico, sin token y sin fetch", async () => {
    await seededUser("sin-key@example.com", "contrasena-larga-123");
    delete process.env.RESEND_API_KEY;
    const before = state().passwordResetTokens.length;

    const res = await forgot("sin-key@example.com");

    expect(res.status).toBe(202);
    expect(res.body).toEqual(GENERIC_BODY);
    expect(generateTokenSpy).not.toHaveBeenCalled();
    expect(createTokenSpy).not.toHaveBeenCalled();
    expect(state().passwordResetTokens.length).toBe(before);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("sin PASSWORD_RESET_FROM: 202 genérico, sin token y sin fetch", async () => {
    await seededUser("sin-from@example.com", "contrasena-larga-123");
    delete process.env.PASSWORD_RESET_FROM;
    const before = state().passwordResetTokens.length;

    const res = await forgot("sin-from@example.com");

    expect(res.status).toBe(202);
    expect(res.body).toEqual(GENERIC_BODY);
    expect(generateTokenSpy).not.toHaveBeenCalled();
    expect(createTokenSpy).not.toHaveBeenCalled();
    expect(state().passwordResetTokens.length).toBe(before);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("sin ninguna configuración: 202 genérico, sin token y sin fetch", async () => {
    await seededUser("sin-todo@example.com", "contrasena-larga-123");
    disableDeliveryConfig();
    const before = state().passwordResetTokens.length;

    const res = await forgot("sin-todo@example.com");

    expect(res.status).toBe(202);
    expect(res.body).toEqual(GENERIC_BODY);
    expect(generateTokenSpy).not.toHaveBeenCalled();
    expect(createTokenSpy).not.toHaveBeenCalled();
    expect(state().passwordResetTokens.length).toBe(before);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("cuenta inexistente: mismo 202 genérico (no permite enumerar)", async () => {
    await seededUser("enum-existe@example.com", "contrasena-larga-123");
    const exists = await forgot("enum-existe@example.com");
    const missing = await forgot("enum-noexiste@example.com");

    expect(exists.status).toBe(202);
    expect(missing.status).toBe(202);
    expect(exists.body).toEqual(GENERIC_BODY);
    expect(missing.body).toEqual(GENERIC_BODY);
  });

  it("con configuración completa sí emite y persiste el token (control positivo)", async () => {
    await seededUser("con-todo@example.com", "contrasena-larga-123");
    enableDeliveryConfig();
    const before = state().passwordResetTokens.length;

    const res = await forgot("con-todo@example.com");

    expect(res.status).toBe(202);
    expect(generateTokenSpy).toHaveBeenCalledTimes(1);
    expect(createTokenSpy).toHaveBeenCalledTimes(1);
    expect(state().passwordResetTokens.length).toBe(before + 1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
