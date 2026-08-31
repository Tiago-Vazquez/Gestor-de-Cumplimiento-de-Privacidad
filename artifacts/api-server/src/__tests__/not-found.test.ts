import { describe, it, expect, vi } from "vitest";
import type { Request, Response } from "express";
import { notFoundHandler } from "../middlewares/not-found";
import { createMockRequest, createMockResponse } from "./test-utils";

describe("notFoundHandler", () => {
  it("responds with 404 problem+json for unmatched routes", () => {
    const req = createMockRequest("/api/nonexistent", "GET");
    const res = createMockResponse();
    notFoundHandler(req as Request, res as unknown as Response, vi.fn());

    expect(res.statusCode).toBe(404);
    expect(res.body).toMatchObject({
      type: "about:blank",
      title: "Not Found",
      status: 404,
    });
  });

  it("includes the method and path in the detail message", () => {
    const req = createMockRequest("/api/unknown", "DELETE");
    const res = createMockResponse();
    notFoundHandler(req as Request, res as unknown as Response, vi.fn());

    expect((res.body as Record<string, unknown>).detail).toBe(
      "Route DELETE /api/unknown does not exist",
    );
  });

  it("sets the instance to the request path", () => {
    const req = createMockRequest("/api/missing", "GET");
    const res = createMockResponse();
    notFoundHandler(req as Request, res as unknown as Response, vi.fn());

    expect((res.body as Record<string, unknown>).instance).toBe("/api/missing");
  });
});