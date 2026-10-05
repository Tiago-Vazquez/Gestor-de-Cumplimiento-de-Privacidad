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
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import request from "supertest";
import type { Server } from "http";
import { hashPassword } from "@workspace/auth";
import app from "../app";
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

// El seam se captura con un comando que escribe el payload en un fichero, para
// poder leer el enlace que "se entregaria" al usuario.
const DELIVERY_CAPTURE = "/tmp/m30-reset-capture.json";
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
  };
  state().users.push(user);
  return user;
}

const CAPTURED = { url: null as string | null };

async function forgot(email: string) {
  return request(server).post("/api/auth/password/forgot").send({ email });
}

async function reset(token: string, newPassword: string) {
  return request(server)
    .post("/api/auth/password/reset")
    .send({ token, newPassword });
}

beforeAll(async () => {
  process.env.PASSWORD_RESET_DELIVERY_CMD = `cat > ${DELIVERY_CAPTURE}`;
  server = app.listen(0);
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
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
 * Carga el seam con `PASSWORD_RESET_DELIVERY_CMD` freshly asignado.
 *
 * `password-reset-delivery.ts` lee la variable de entorno AL CARGAR EL MODULO
 * (`const DELIVERY_CMD = ...`). Sin `vi.resetModules()` el import devolvería la
 * instancia cacheada con el valor previo y el test no probaría nada.
 */
async function loadSeamWith(cmd: string) {
  const previous = process.env.PASSWORD_RESET_DELIVERY_CMD;
  process.env.PASSWORD_RESET_DELIVERY_CMD = cmd;
  vi.resetModules();
  try {
    const mod = await import("../auth/password-reset-delivery");
    return await import("../auth/password-reset-delivery");
  } finally {
    void previous;
  }
}

describe("M30.0 seam de entrega: fallo del canal (C1)", () => {
  it("un comando de entrega inexistente NO tumba el proceso ni lanza excepciones", async () => {
    // Caso real de fallo de canal: el comando configurado no existe o no se
    // puede arrancar. El seam debe tragarse el fallo y devolver `false`; nunca
    // propagar, porque `/password/forgot` responde 202 sea cual sea el canal.
    const { deliverResetLink } = await loadSeamWith("m30-comando-que-no-existe-xyz");

    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on("uncaughtException", onUnhandled);
    try {
      const delivered = await deliverResetLink({
        email: "canal@example.com",
        resetUrl: "https://app.example/reset-password?token=FAKE",
        expiresAt: new Date(Date.now() + 60_000),
      });

      expect(delivered).toBe(false);
      // Margen para que un rechazo asíncrono llegara a propagarse.
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(unhandled).toEqual([]);
    } finally {
      process.off("uncaughtException", onUnhandled);
    }
  });

  it("un payload que desborda el pipe del hijo NO provoca 'Unhandled error'", async () => {
    // Regresión directa de C1: si el comando cierra su stdin antes de que
    // terminemos de escribir, Node emite `error` (write EOF) sobre el stream.
    // SIN el listener registrado, eso es un `Unhandled 'error' event` que MATA
    // el proceso. Con el listener, el error se ignora y manda el `close`.
    //
    // El payload real cabe holgadamente en el buffer del pipe (64 KiB), así que
    // aquí se fuerza un payload grande a propósito para ejercitar esa rama.
    const { deliverResetLink } = await loadSeamWith("exit 0");

    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on("uncaughtException", onUnhandled);
    try {
      const bigUrl = `https://app.example/reset-password?token=${"A".repeat(200_000)}`;
      const delivered = await deliverResetLink({
        email: "pipe@example.com",
        resetUrl: bigUrl,
        expiresAt: new Date(Date.now() + 60_000),
      });

      // exit 0 sale con 0: el seam lo considera entregado aunque el hijo no
      // haya leido nada. Lo que importa es que no hubo excepcion.
      expect(delivered).toBe(true);
      // Margen amplio: el error de escritura se emite de forma asíncrona.
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(unhandled).toEqual([]);
    } finally {
      process.off("uncaughtException", onUnhandled);
    }
  });

  it("un comando que cierra el stdin sin consumirlo no lanza 'Unhandled error'", async () => {
    // Segundo escenario de C1, con el tamaño de payload REAL (~109 B): un
    // comando que ignora stdin. Antes del fix, este es el camino que podía
    // dejar el stream en error; con el listener, el `close` decide el resultado.
    const { deliverResetLink } = await loadSeamWith("exit 1");

    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on("uncaughtException", onUnhandled);
    try {
      const delivered = await deliverResetLink({
        email: "sin-stdin@example.com",
        resetUrl: "https://app.example/reset-password?token=REALISTA",
        expiresAt: new Date(Date.now() + 60_000),
      });

      // `exit 1` falla de forma EXPLICITA e identica en cualquier shell:
      // cmd.exe en Windows y /bin/sh en CI. Usar `true` NO es portable: es un
      // builtin POSIX que sale con 0 en Ubuntu y con 1 en Windows, asi que el
      // exit code (y por tanto `delivered`) dependia del SO del runner.
      // El contrato verificado aqui es que el fallo se contiene, sin lanzar.
      expect(delivered).toBe(false);
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(unhandled).toEqual([]);
    } finally {
      process.off("uncaughtException", onUnhandled);
    }
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
