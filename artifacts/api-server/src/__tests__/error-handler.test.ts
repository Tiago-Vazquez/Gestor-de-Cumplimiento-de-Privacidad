import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Request, Response } from "express";
import { ZodError, z } from "zod";
import { AppError } from "../lib/errors";
import {
  createMockRequest,
  createMockResponse,
  type MockResponse,
} from "./test-utils";

vi.mock("../lib/logger", () => ({
  logger: {
    error: vi.fn(),
    warn: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
  },
}));

async function loadErrorHandler() {
  const { errorHandler } = await import("../middlewares/error-handler");
  return errorHandler;
}

describe("errorHandler", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("maps ZodError to 400 with sanitized issues", async () => {
    const errorHandler = await loadErrorHandler();
    const schema = z.object({ status: z.string() });
    const result = schema.safeParse({ status: 123 });
    expect(result.success).toBe(false);
    if (result.success) return;

    const req = createMockRequest();
    const res = createMockResponse();
    errorHandler(result.error, req as Request, res as unknown as Response, vi.fn());

    expect(res.statusCode).toBe(400);
    expect(res.body).toMatchObject({
      type: "about:blank",
      title: "Bad Request",
      status: 400,
      detail: "Validation failed",
    });
    expect((res.body as Record<string, unknown>).errors).toBeDefined();
  });

  it("maps AppError to its own status and title", async () => {
    const errorHandler = await loadErrorHandler();
    const err = new AppError(418, "I'm a teapot", "Short and stout");
    const req = createMockRequest();
    const res = createMockResponse();
    errorHandler(err, req as Request, res as unknown as Response, vi.fn());

    expect(res.statusCode).toBe(418);
    expect(res.body).toEqual({
      type: "about:blank",
      title: "I'm a teapot",
      status: 418,
      detail: "Short and stout",
      instance: "/api/test",
    });
  });

  it("maps entity.parse.failed to 400", async () => {
    const errorHandler = await loadErrorHandler();
    const err = new SyntaxError("Unexpected end of JSON");
    (err as unknown as { type: string }).type = "entity.parse.failed";
    const req = createMockRequest();
    const res = createMockResponse();
    errorHandler(err, req as Request, res as unknown as Response, vi.fn());

    expect(res.statusCode).toBe(400);
    expect(res.body).toMatchObject({
      title: "Bad Request",
      detail: "Malformed request body",
    });
  });

  it("maps entity.too.large to 413", async () => {
    const errorHandler = await loadErrorHandler();
    const err = new Error("request entity too large");
    (err as unknown as { type: string }).type = "entity.too.large";
    const req = createMockRequest();
    const res = createMockResponse();
    errorHandler(err, req as Request, res as unknown as Response, vi.fn());

    expect(res.statusCode).toBe(413);
    expect(res.body).toMatchObject({
      title: "Payload Too Large",
      detail: "Request body exceeds the allowed size",
    });
  });

  it("maps unknown errors to 500 without leaking details in production", async () => {
    vi.resetModules();
    vi.stubEnv("NODE_ENV", "production");
    const { errorHandler } = await import("../middlewares/error-handler");

    const err = new Error("super secret internal detail");
    const req = createMockRequest();
    const res = createMockResponse();
    errorHandler(err, req as Request, res as unknown as Response, vi.fn());

    expect(res.statusCode).toBe(500);
    expect(res.body).toMatchObject({
      type: "about:blank",
      title: "Internal Server Error",
      status: 500,
    });
    expect((res.body as Record<string, unknown>).detail).toBeUndefined();
  });

  it("includes error message in detail when not in production", async () => {
    vi.resetModules();
    vi.stubEnv("NODE_ENV", "development");
    const { errorHandler } = await import("../middlewares/error-handler");

    const err = new Error("debug info");
    const req = createMockRequest();
    const res = createMockResponse();
    errorHandler(err, req as Request, res as unknown as Response, vi.fn());

    expect(res.statusCode).toBe(500);
    expect((res.body as Record<string, unknown>).detail).toBe("debug info");
  });

  it("delegates to next when headers are already sent", async () => {
    const errorHandler = await loadErrorHandler();
    const req = createMockRequest();
    const res = createMockResponse();
    (res as MockResponse).headersSent = true;
    const next = vi.fn();

    errorHandler(new Error("too late"), req as Request, res as unknown as Response, next);
    expect(next).toHaveBeenCalled();
  });
});