import type { Request, Response } from "express";
import { vi } from "vitest";

export interface MockResponse extends Response {
  statusCode: number;
  body: unknown;
}

export function createMockRequest(
  originalUrl = "/api/test",
  method = "GET",
): Request {
  return {
    originalUrl,
    path: originalUrl.split("?")[0],
    method,
    id: "req-test",
  } as unknown as Request;
}

export function createMockResponse(): MockResponse {
  const state = {
    statusCode: 200,
    body: undefined as unknown,
    headersSent: false,
  };

  const handlers = {
    status(code: number) {
      state.statusCode = code;
      return this;
    },
    set() {
      return this;
    },
    json(body: unknown) {
      state.body = body;
      return this;
    },
  };

  return {
    ...handlers,
    get headersSent() {
      return state.headersSent;
    },
    set headersSent(value: boolean) {
      state.headersSent = value;
    },
    get statusCode() {
      return state.statusCode;
    },
    get body() {
      return state.body;
    },
  } as unknown as MockResponse;
}

/**
 * M11.1 — Obtiene el token CSRF de synchronizer de una sesión (cookie) mediante
 * `GET /api/csrf-token`. Usado por los tests HTTP que mutan con cookie: tras el
 * login obtienen el token y lo envían en el header `X-CSRF-Token`.
 */
export async function fetchCsrfToken(
  server: ReturnType<import("express").Express["listen"]>,
  cookie: string,
): Promise<string> {
  const request = (await import("supertest")).default;
  const res = await request(server).get("/api/csrf-token").set("Cookie", cookie);
  if (res.status !== 200 || typeof res.body?.csrfToken !== "string") {
    throw new Error("csrf-token endpoint did not return a token");
  }
  return res.body.csrfToken as string;
}
