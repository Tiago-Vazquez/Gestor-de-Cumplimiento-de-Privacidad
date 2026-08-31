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
