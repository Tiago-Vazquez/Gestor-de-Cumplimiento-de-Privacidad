import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  deliverResetLink,
  isPasswordResetDeliveryConfigured,
} from "../auth/password-reset-delivery";
import { resetLinkBase } from "../routes/auth";
import { logger } from "../lib/logger";
process.env.AUTH_DISABLED = "false";
process.env.JWT_SECRET = "test-secret-of-at-least-32-characters!!";

// Mock database dependencies to avoid DATABASE_URL requirement
vi.mock("@workspace/db", () => ({ pool: { query: vi.fn(), end: vi.fn() } }));
vi.mock("../repositories", async () => {
  const { createMockRepos } = await import("./mock-repos");
  const created = createMockRepos();
  return { repos: created.repos };
});

// Mock secret-manager
vi.mock("../lib/secret-manager", () => ({
  encrypt: vi.fn((data) => Buffer.from(data, "utf-8").toString("base64")),
  decrypt: vi.fn((data) => data),
}));

// Mock totp
vi.mock("../lib/totp", () => ({
  generateTotpSecret: vi.fn(),
  verifyTotp: vi.fn(),
  buildOtpauthUrl: vi.fn(),
}));

// Mock rate-limit-store
vi.mock("../lib/rate-limit-store", () => ({
  optionalPersistentStore: vi.fn(),
}));

// Mock audit
vi.mock("../lib/audit", () => ({
  recordAuditEvent: vi.fn(),
}));

describe("M31.0 — deliverResetLink (adaptador Resend, unidad aislada)", () => {
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
    delete process.env.PASSWORD_RESET_BASE_URL;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
    delete process.env.RESEND_API_KEY;
    delete process.env.PASSWORD_RESET_FROM;
    delete process.env.PASSWORD_RESET_BASE_URL;
    vi.restoreAllMocks();
  });

  it("devuelve false cuando falta RESEND_API_KEY", async () => {
    delete process.env.RESEND_API_KEY;
    await expect(deliverResetLink(input)).resolves.toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("devuelve false cuando falta PASSWORD_RESET_FROM", async () => {
    delete process.env.PASSWORD_RESET_FROM;
    await expect(deliverResetLink(input)).resolves.toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("isPasswordResetDeliveryConfigured refleja la presencia de credenciales", () => {
    expect(isPasswordResetDeliveryConfigured()).toBe(true);
    delete process.env.RESEND_API_KEY;
    expect(isPasswordResetDeliveryConfigured()).toBe(false);
    process.env.RESEND_API_KEY = "test-resend-api-key";
    delete process.env.PASSWORD_RESET_FROM;
    expect(isPasswordResetDeliveryConfigured()).toBe(false);
  });

  it("devuelve true cuando Resend responde 2xx", async () => {
    fetchMock.mockResolvedValue({ ok: true, status: 200 } as Response);
    await expect(deliverResetLink(input)).resolves.toBe(true);
  });

  it("devuelve false cuando Resend responde 4xx/5xx", async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 500 } as Response);
    await expect(deliverResetLink(input)).resolves.toBe(false);
  });

  it("devuelve false cuando fetch lanza error de red", async () => {
    fetchMock.mockRejectedValue(new Error("network down"));
    await expect(deliverResetLink(input)).resolves.toBe(false);
  });

  it("aborta la señal entregada a fetch y devuelve false al vencer el timeout de 10s", async () => {
    vi.useFakeTimers();

    // `fetch` simulado: escucha la AbortSignal recibida y rechaza al abortarse.
    let receivedSignal: AbortSignal | undefined;
    fetchMock.mockImplementation((_url: string, init: RequestInit) => {
      receivedSignal = init.signal as AbortSignal;
      return new Promise<Response>((_resolve, reject) => {
        receivedSignal!.addEventListener("abort", () => {
          const err = new Error("The operation was aborted");
          err.name = "AbortError";
          reject(err);
        });
      });
    });

    const pending = deliverResetLink(input);

    // La solicitud está en vuelo: `fetch` recibió una AbortSignal NO abortada aún.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(receivedSignal).toBeInstanceOf(AbortSignal);
    expect(receivedSignal!.aborted).toBe(false);

    // Justo antes del límite, nada se cancela.
    await vi.advanceTimersByTimeAsync(9_999);
    expect(receivedSignal!.aborted).toBe(false);

    // Al cumplirse los 10.000 ms la señal se aborta y la entrega resuelve `false`.
    await vi.advanceTimersByTimeAsync(1);
    expect(receivedSignal!.aborted).toBe(true);
    await expect(pending).resolves.toBe(false);
  });

  it("no revela secretos en los logs cuando ocurre el timeout", async () => {
    vi.useFakeTimers();
    const errorSpy = vi.spyOn(logger, "error").mockImplementation(() => {});

    let receivedSignal: AbortSignal | undefined;
    fetchMock.mockImplementation((_url: string, init: RequestInit) => {
      receivedSignal = init.signal as AbortSignal;
      return new Promise<Response>((_resolve, reject) => {
        receivedSignal!.addEventListener("abort", () => {
          const err = new Error("The operation was aborted");
          err.name = "AbortError";
          reject(err);
        });
      });
    });

    const pending = deliverResetLink(input);
    await vi.advanceTimersByTimeAsync(10_000);
    await expect(pending).resolves.toBe(false);

    expect(errorSpy).toHaveBeenCalled();
    const logged = JSON.stringify(errorSpy.mock.calls);
    expect(logged).not.toContain("test-resend-api-key");
    expect(logged).not.toContain("SECRETTOKEN");
    expect(logged).not.toContain(input.resetUrl);
    errorSpy.mockRestore();
  });

  it("limpia el temporizador de 10s cuando la entrega termina antes del timeout", async () => {
    vi.useFakeTimers();
    fetchMock.mockResolvedValue({ ok: true, status: 200 } as Response);
    await expect(deliverResetLink(input)).resolves.toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("limpia el temporizador de 10s cuando fetch falla antes del timeout", async () => {
    vi.useFakeTimers();
    fetchMock.mockRejectedValue(new Error("network down"));
    await expect(deliverResetLink(input)).resolves.toBe(false);
    // Si `clearTimeout` no estuviera en el `finally` quedaría 1 timer pendiente.
    expect(vi.getTimerCount()).toBe(0);
  });

  it("limpia el temporizador de 10s cuando Resend responde no-2xx", async () => {
    vi.useFakeTimers();
    fetchMock.mockResolvedValue({ ok: false, status: 503 } as Response);
    await expect(deliverResetLink(input)).resolves.toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("envía al endpoint correcto con encabezados y cuerpo esperados", async () => {
    fetchMock.mockResolvedValue({ ok: true, status: 200 } as Response);
    await deliverResetLink(input);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.resend.com/emails");

    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer test-resend-api-key");
    expect(headers["Content-Type"]).toBe("application/json");

    const body = JSON.parse(init.body as string);
    expect(body.from).toBe("Privaris <no-reply@example.com>");
    expect(body.to).toEqual(["destino@example.com"]);
    expect(body.text).toContain(input.resetUrl);
    expect(body.html).toContain(input.resetUrl);
  });

  it("no registra la API key ni el reset URL en logs", async () => {
    const errorSpy = vi.spyOn(logger, "error").mockImplementation(() => {});
    fetchMock.mockResolvedValue({ ok: false, status: 500 });
    await deliverResetLink(input);

    expect(errorSpy).toHaveBeenCalled();
    const logged = JSON.stringify(errorSpy.mock.calls);
    expect(logged).not.toContain("test-resend-api-key");
    expect(logged).not.toContain("SECRETTOKEN");
    expect(logged).not.toContain(input.resetUrl);
    errorSpy.mockRestore();
  });
});

describe("M31.0 — resetLinkBase (construcción segura de URL de recuperación)", () => {
  const fakeReq = (host?: string, protocol = "https") => ({
    get: (name: string) => (name === "host" ? host : undefined),
    protocol,
  } as { protocol: string; get(name: string): string | undefined });

  beforeEach(() => {
    delete process.env.PASSWORD_RESET_BASE_URL;
  });

  afterEach(() => {
    delete process.env.PASSWORD_RESET_BASE_URL;
  });

  it("retorna null cuando PASSWORD_RESET_BASE_URL no está configurada (no hay fallback a Host)", () => {
    const result = resetLinkBase(fakeReq("attacker-controlled.host"));
    expect(result).toBeNull();
  });

  it("retorna null cuando PASSWORD_RESET_BASE_URL está vacía", () => {
    process.env.PASSWORD_RESET_BASE_URL = "";
    const result = resetLinkBase(fakeReq("legit.example.com"));
    expect(result).toBeNull();
  });

  it("retorna null cuando PASSWORD_RESET_BASE_URL no es HTTPS", () => {
    process.env.PASSWORD_RESET_BASE_URL = "http://insecure.example.com";
    const result = resetLinkBase(fakeReq("legit.example.com"));
    expect(result).toBeNull();
  });

  it("retorna null cuando PASSWORD_RESET_BASE_URL es una URL malformada", () => {
    process.env.PASSWORD_RESET_BASE_URL = "not-a-url";
    const result = resetLinkBase(fakeReq("legit.example.com"));
    expect(result).toBeNull();
  });

  it("retorna la URL base limpia cuando PASSWORD_RESET_BASE_URL es HTTPS válida", () => {
    process.env.PASSWORD_RESET_BASE_URL = "https://app.example.com///";
    const result = resetLinkBase(fakeReq("irrelevant.host"));
    expect(result).toBe("https://app.example.com");
  });

  it("no depende del encabezado Host aunque esté presente", () => {
    process.env.PASSWORD_RESET_BASE_URL = "https://app.example.com";
    const result = resetLinkBase(fakeReq("attacker-controlled.host"));
    expect(result).toBe("https://app.example.com");
    expect(result).not.toContain("attacker-controlled");
  });
});
